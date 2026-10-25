import { useEffect, useRef, useState } from "react";
import { apiAdmin, ApiError } from "../../api";
import type { OrgAgentDuty } from "../../types";
import { StatusBadge, type Tone } from "./StatusBadge";
import { DeniedState, EmptyState, ErrorState, Skeleton } from "./states";
import { ConfirmDialog } from "./ConfirmDialog";

/* P18.1 — Agent duty management section. Reusable: the Objective
   Detail page mounts it with objectiveId (read = GET
   /vnext/objectives/:id/duties, display still filtered to duties whose
   exact set covers it); the Company page mounts it without (read = GET
   /vnext/businesses/:id/duties). Lists render canonical rows verbatim.
   Assign posts agentId + exact objective_ids + note + dedup_key — one
   minted key per operation signature, replayed verbatim on ambiguous-
   failure retry. Suspend/resume post directly; revoke is terminal →
   ConfirmDialog. Authority is the x-operator-id header — never a body
   field. */

type ObjLite = { objective_id: string; title?: string | null; status: string };
type AgentLite = {
  agent_id: string;
  title?: string | null;
  department?: string | null;
  state?: string;
};
type CtlAction = "suspend" | "resume" | "revoke";

type St =
  | { kind: "loading" }
  | { kind: "ready"; forKey: string; duties: OrgAgentDuty[]; atMs: number }
  | { kind: "error"; err: ApiError };

const STATE_TONE: Record<string, Tone> = {
  ACTIVE: "ok",
  SUSPENDED: "warn",
  REVOKED: "danger",
};
const OBJ_TONE: Record<string, Tone> = {
  DRAFT: "unknown",
  PROPOSED: "info",
  RUNNING: "info",
  PAUSED: "warn",
  ACHIEVED: "ok",
  CANCELLED: "unknown",
  FAILED: "danger",
  EXPIRED: "warn",
};

/* Backend code → owner-actionable gloss. Unknown codes still render
   verbatim (code + detail) — never swallowed. */
const ERR_HINT: Record<string, string> = {
  FAIL_CLOSED_DUTY_AUTHORITY: "you must own every covered objective",
  FAIL_CLOSED_DUTY_BUSINESS: "duties cannot span businesses or foreign agents",
  FAIL_CLOSED_DUTY_AGENT: "the agent does not exist in this business",
  FAIL_CLOSED_DUTY_OBJECTIVE: "a covered objective is not canonical here",
  FAIL_CLOSED_DUTY_STATE: "state changed — refresh and retry",
};

function describeErr(e: unknown): string {
  if (e instanceof ApiError) {
    const hint = ERR_HINT[e.code];
    if (hint) return `${e.code} — ${hint}${e.detail ? ` (${e.detail})` : ""}`;
    return e.detail ? `${e.code}: ${e.detail}` : e.code;
  }
  return String(e);
}

const arr = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

const fmtD = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  const s = String(v);
  return s.length >= 19 ? s.slice(0, 19).replace("T", " ") : s;
};

/* OrgAgentRow exposes `status`; the prop contract exposes `state` —
   read both, never invent one. */
const agentState = (a: AgentLite): string =>
  a.state ?? String((a as unknown as Record<string, unknown>).status ?? "");

export function AgentDuties(props: {
  businessId: string;
  objectiveId?: string;
  objectives: ObjLite[];
  agents: AgentLite[];
  onChanged?: () => void;
}): JSX.Element {
  const { businessId, objectiveId } = props;
  const scopeKey = objectiveId ? `obj:${objectiveId}` : `biz:${businessId}`;
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [mutBusy, setMutBusy] = useState(false);
  const [mutNote, setMutNote] = useState<string | null>(null);
  const [dlg, setDlg] = useState<OrgAgentDuty | null>(null);
  const [aAgent, setAAgent] = useState("");
  const [aObjs, setAObjs] = useState<string[]>(() => (objectiveId ? [objectiveId] : []));
  const [aNote, setANote] = useState("");
  const lastApplied = useRef(0);
  const opSeq = useRef(0);
  const dedupKeys = useRef<Record<string, string>>({});
  const onChangedRef = useRef(props.onChanged);
  onChangedRef.current = props.onChanged;

  /* Scope change (objective or business) closes the dialog, resets the
     assign form (prefilling the scoped objective when present), and
     bumps the in-flight guard — a stale mutation can never attribute
     to a different scope. */
  useEffect(() => {
    setDlg(null);
    setMutNote(null);
    setMutBusy(false);
    setAAgent("");
    setAObjs(objectiveId ? [objectiveId] : []);
    setANote("");
    lastApplied.current = 0;
    dedupKeys.current = {};
    opSeq.current++;
  }, [businessId, objectiveId]);

  /* 8s canonical poll — same convention as the cockpit read: each tick
     aborts the previous request and a response older than the last
     applied one is dropped, so a stale poll can never overwrite. */
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, 8000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    /* Silent re-poll: keep the last good snapshot for THIS scope while
       refetching; collapse to loading only on scope change or before
       the first successful read. */
    setSt((prev) => (prev.kind === "ready" && prev.forKey === scopeKey ? prev : { kind: "loading" }));
    if (!businessId) return;
    if (objectiveId && !objectiveId.trim()) return;
    const ctl = new AbortController();
    const read = objectiveId
      ? apiAdmin.objectiveDutiesApp(objectiveId, ctl.signal)
      : apiAdmin.businessDutiesApp(businessId, ctl.signal);
    read
      .then((r) => {
        if (ctl.signal.aborted) return;
        const atMs = Date.now();
        if (atMs <= lastApplied.current) return;
        lastApplied.current = atMs;
        setSt({
          kind: "ready",
          forKey: scopeKey,
          duties: arr(r.duties).filter((x) => x !== null && typeof x === "object" && !!x.duty_id),
          atMs,
        });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        lastApplied.current = Date.now();
        setSt({
          kind: "error",
          err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)),
        });
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, objectiveId, scopeKey, tick]);

  const runCtl = (d: OrgAgentDuty, action: CtlAction) => {
    const seq = ++opSeq.current;
    setDlg(null);
    setMutBusy(true);
    setMutNote(null);
    apiAdmin
      .dutyControlApp(d.duty_id, action)
      .then((r) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        const rd = r?.duty;
        if (!rd || String(rd.duty_id) !== d.duty_id) {
          setMutNote(
            `Duty ${action} returned an inconsistent response — canonical list refetched; verify state before retrying.`,
          );
        } else {
          setMutNote(`Duty ${action} committed — canonical list refreshed.`);
        }
        setTick((n) => n + 1);
        onChangedRef.current?.();
      })
      .catch((e: unknown) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        setMutNote(`Duty ${action} failed: ${describeErr(e)}`);
        // A committed-but-lost lifecycle lands as FAIL_CLOSED_*_STATE —
        // re-tick the poll so the canonical row repaints immediately.
        if (e instanceof ApiError && e.code.endsWith("_STATE")) setTick((n) => n + 1);
      });
  };

  const submitAssign = () => {
    if (!businessId || !aAgent || aObjs.length === 0 || mutBusy) return;
    const agent = aAgent;
    /* Exact-set semantics: the covered set is the authority boundary.
       Sort for a canonical signature — same set ⇒ same operation ⇒
       same replayed dedup_key. */
    const objs = [...aObjs].sort();
    const note = aNote.trim();
    const seq = ++opSeq.current;
    const sig = JSON.stringify(["duty", businessId, agent, objs]);
    let key = dedupKeys.current[sig];
    if (!key) {
      key = `ui-duty-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      dedupKeys.current[sig] = key;
    }
    setMutBusy(true);
    setMutNote(null);
    apiAdmin
      .createDutyApp(agent, {
        objective_ids: objs,
        note: note || undefined,
        dedup_key: key,
      })
      .then((r) => {
        if (seq !== opSeq.current) return;
        delete dedupKeys.current[sig];
        setMutBusy(false);
        const d = r?.duty;
        setMutNote(
          `Duty committed${d && d.duty_id ? ` (${d.duty_id})` : ""} — canonical list refreshed.`,
        );
        setAAgent("");
        setANote("");
        setTick((n) => n + 1);
        onChangedRef.current?.();
      })
      .catch((e: unknown) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        const definitive = e instanceof ApiError && e.status >= 400 && e.status < 500;
        if (definitive) delete dedupKeys.current[sig];
        setMutNote(
          `Assign duty failed: ${describeErr(e)}${
            !definitive ? " — result ambiguous; the same dedup_key is kept for retry" : ""
          }`,
        );
      });
  };

  const titleOf = (id: string): string => {
    const o = props.objectives.find((x) => x.objective_id === id);
    return (o && o.title ? String(o.title) : "") || id;
  };
  const agentLabel = (id: string): string => {
    const a = props.agents.find((x) => x.agent_id === id);
    return (a && a.title ? String(a.title) : "") || id;
  };

  const heading = objectiveId ? "Duties covering this objective" : "Agent duties";
  const ready = st.kind === "ready" && st.forKey === scopeKey ? st : null;
  /* Objective scope: only duties whose exact set covers this objective
     render — an honest filter over canonical rows, never a claim. */
  const shown = ready
    ? objectiveId
      ? ready.duties.filter((d) => arr(d.objective_ids).includes(objectiveId))
      : ready.duties
    : [];

  const knownIds = new Set(props.objectives.map((o) => o.objective_id));
  const unknownSel = aObjs.filter((id) => !knownIds.has(id));

  return (
    <section aria-label="agent duties">
      <h2 className="sech">{heading}</h2>
      <div className="sub">
        Canonical org-agent duty bindings
        {objectiveId ? ` restricted to sets covering ${objectiveId}` : ` in ${businessId}`}. A duty
        binds an agent to an exact objective set.
      </div>

      {mutNote ? (
        <div className="trunc" role="status">
          {mutNote}
        </div>
      ) : null}

      {ready === null ? (
        st.kind === "error" ? (
          st.err.status === 403 ? (
            <DeniedState detail={`${st.err.detail || "You don't own this scope."} (${st.err.code})`} />
          ) : (
            <ErrorState
              code={st.err.status === 401 ? st.err.code || "UNAUTHORIZED" : st.err.code}
              detail={
                st.err.status === 401
                  ? `Your credentials were rejected — update the session token and retry. ${st.err.detail}`
                  : st.err.code.startsWith("FAIL_CLOSED")
                    ? `Integrity check failed — possibly-corrupt data was not rendered. ${st.err.detail}`
                    : st.err.detail
              }
              onRetry={() => setTick((n) => n + 1)}
            />
          )
        ) : (
          <div className="need">
            {[0, 1].map((i) => (
              <div className="nrow" key={i}>
                <Skeleton height={12} width="55%" />
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="need" aria-label="duty list">
          {shown.length === 0 ? (
            <div className="nrow">
              <span className="note">
                {objectiveId
                  ? "No duties cover this objective — exact-set bindings appear here."
                  : "No duties — agent bindings appear here."}
              </span>
            </div>
          ) : null}
          {shown.map((d) => (
            <div className="nrow" key={d.duty_id}>
              <span className="tt" title={d.org_agent_id}>
                {agentLabel(d.org_agent_id)}
              </span>
              <StatusBadge tone={STATE_TONE[d.state] ?? "unknown"} label={d.state} />
              <span className="note">
                covers{" "}
                {arr(d.objective_ids).length === 0
                  ? "no objectives"
                  : arr(d.objective_ids)
                      .map((id) => titleOf(id))
                      .join(" + ")}
                {d.note ? ` · ${String(d.note)}` : ""} · created {fmtD(d.created_at)}
              </span>
              {d.state === "ACTIVE" ? (
                <button className="ghost" disabled={mutBusy} onClick={() => runCtl(d, "suspend")}>
                  Suspend
                </button>
              ) : null}
              {d.state === "SUSPENDED" ? (
                <button className="ghost" disabled={mutBusy} onClick={() => runCtl(d, "resume")}>
                  Resume
                </button>
              ) : null}
              {d.state !== "REVOKED" ? (
                <button className="ghost" disabled={mutBusy} onClick={() => setDlg(d)}>
                  Revoke
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <section className="oform" aria-label="assign duty">
        {props.agents.length === 0 ? (
          <EmptyState
            title="No agents"
            detail="No org agents are listed for this business — duties cannot be assigned."
          />
        ) : null}
        <div className="ofrow2">
          <div className="ofrow">
            <label htmlFor="duty-agent">agent</label>
            <select
              id="duty-agent"
              value={aAgent}
              onChange={(e) => setAAgent(e.target.value)}
              disabled={props.agents.length === 0}
            >
              <option value="">— select agent —</option>
              {props.agents.map((a) => (
                <option key={a.agent_id} value={a.agent_id}>
                  {(a.title ? String(a.title) : a.agent_id)}
                  {a.department ? ` · ${a.department}` : ""}
                  {agentState(a) ? ` · ${agentState(a)}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="ofrow">
            <label htmlFor="duty-note">note (optional)</label>
            <input
              id="duty-note"
              value={aNote}
              onChange={(e) => setANote(e.target.value)}
              placeholder="why this binding exists"
            />
          </div>
        </div>
        <div className="ofrow">
          <label>covered objective set (exact)</label>
          <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {props.objectives.length === 0 ? (
              <span className="note">No objectives in this business to cover.</span>
            ) : null}
            {props.objectives.map((o) => (
              <label
                key={o.objective_id}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  fontSize: 13,
                  color: "var(--text-1)",
                }}
              >
                <input
                  type="checkbox"
                  checked={aObjs.includes(o.objective_id)}
                  onChange={(e) =>
                    setAObjs(
                      e.target.checked
                        ? [...aObjs, o.objective_id]
                        : aObjs.filter((x) => x !== o.objective_id),
                    )
                  }
                  style={{ width: "auto", margin: 0 }}
                />
                <span title={o.objective_id}>{(o.title ? String(o.title) : o.objective_id)}</span>
                <StatusBadge tone={OBJ_TONE[o.status] ?? "unknown"} label={o.status} />
              </label>
            ))}
          </div>
          {unknownSel.length > 0 ? (
            <span className="note">
              also selected (not in the current list): {unknownSel.join(", ")}
            </span>
          ) : null}
        </div>
        <div className="actions">
          <button
            className="primary"
            disabled={mutBusy || !aAgent || aObjs.length === 0 || props.agents.length === 0}
            title={
              props.agents.length === 0
                ? "No agents to bind"
                : !aAgent
                  ? "Select an agent first"
                  : aObjs.length === 0
                    ? "Select at least one covered objective"
                    : "Commit the canonical duty"
            }
            onClick={submitAssign}
          >
            {mutBusy ? "Working…" : "Assign duty"}
          </button>
        </div>
        <div className="sub">
          A duty binds the agent to exactly this objective set — two narrow duties never combine
          into broader authority. The backend enforces ownership: you must own every covered
          objective, and duties cannot span businesses or foreign agents.
        </div>
      </section>

      <ConfirmDialog
        open={dlg !== null}
        title="Revoke duty"
        body={
          dlg
            ? `Revoke duty ${dlg.duty_id} for ${agentLabel(dlg.org_agent_id)} covering ${arr(dlg.objective_ids).map((id) => titleOf(id)).join(" + ") || "∅"}? Revoking removes this duty's authority permanently — a revoked duty cannot be resumed. The row remains as a tombstone in the canonical list.`
            : ""
        }
        confirmLabel="Revoke duty"
        busy={mutBusy}
        onConfirm={() => {
          if (dlg) runCtl(dlg, "revoke");
        }}
        onCancel={() => setDlg(null)}
      />
    </section>
  );
}
