import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import type {
  AgentContractRow,
  AgentEffectivePolicy,
  AgentInboxMessage,
  OrgAgentRow,
  WorkGraphPayload,
  WorkItemRow,
} from "../types";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { DeniedState, EmptyState, ErrorState, Skeleton } from "../components/states";
import { ConfirmDialog } from "../components/ConfirmDialog";

/* P15.9-B5.1 — Agent Detail (D.5/E.4). Canonical reads only:
   org-agents (global, filtered by route+ business identity), contract,
   effective-policy, inbox, work-items, work-graph. Lifecycle mutations
   (pause/resume/terminate + contract enable/disable) go through a
   pinned ConfirmDialog — never auto-fired, never optimistic, refetched
   canonically on success. All state binds {forBiz, forId}; a foreign
   agent under the current business is denied, never rendered. */

const TERMINAL = new Set(["DONE", "CANCELLED"]);
const AGENT_TONE: Record<string, Tone> = { ACTIVE: "ok", PAUSED: "warn", TERMINATED: "unknown" };
const WI_TONE: Record<string, Tone> = {
  BACKLOG: "unknown", READY: "info", IN_PROGRESS: "purple",
  REVIEW_REQUIRED: "warn", BLOCKED: "danger", DONE: "ok", CANCELLED: "unknown",
};

type Section<T> = { kind: "ready"; data: T } | { kind: "unavailable"; code: string };

type Ready = {
  forBiz: string;
  forId: string;
  agent: OrgAgentRow;
  contract: Section<AgentContractRow | null>;
  policy: Section<AgentEffectivePolicy>;
  /* null = payload present but malformed/corrupt — honest marker,
     never rendered as empty/unrestricted */
  inbox: Section<AgentInboxMessage[] | null>;
  items: Section<WorkItemRow[] | null>;
  graph: Section<WorkGraphPayload>;
};

type St =
  | { kind: "no-business" }
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "foreign" }
  | { kind: "ready"; r: Ready }
  | { kind: "error"; err: ApiError };

type Op = "pause" | "resume" | "terminate" | "enable-contract" | "disable-contract";

const OP_LABEL: Record<Op, string> = {
  pause: "Pause agent",
  resume: "Resume agent",
  terminate: "Terminate agent",
  "enable-contract": "Enable execution contract",
  "disable-contract": "Disable execution contract",
};

function sect<Raw, T>(r: PromiseSettledResult<Raw>, map: (v: Raw) => T): Section<T> {
  if (r.status === "rejected") {
    return { kind: "unavailable", code: r.reason instanceof ApiError ? r.reason.code : "ERROR" };
  }
  return { kind: "ready", data: map(r.value) };
}

function SectMissing(props: { code: string; what: string }) {
  return (
    <div className="nrow">
      <span className="note">
        {props.what} unavailable{props.code === "FAIL_CLOSED_AGENT_CONTRACT_MISSING"
          ? " — no contract materialized (never read as unrestricted)"
          : ` (${props.code})`}. Not zero, not inactive — just not proven.
      </span>
    </div>
  );
}

export function AgentDetail() {
  const { id = "" } = useParams();
  const { biz } = useSelectedBusiness();
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [mutNote, setMutNote] = useState<string | null>(null);
  const [mutBusy, setMutBusy] = useState(false);
  /* The full mutation context is PINNED when the dialog opens:
     operation + agent + business identity as of open. It is invalidated
     on any identity change and never retargeted. */
  const [dlg, setDlg] = useState<{ op: Op; agentId: string; biz: string; label: string } | null>(null);
  const opSeq = useRef(0);
  const lastIdent = useRef<{ biz: string; id: string } | null>(null);

  useEffect(() => {
    /* IDENTITY change only (biz/route) closes pending confirmations,
       clears notes and bumps the in-flight guard — a canonical refetch
       (tick) must NOT wipe a freshly committed mutation note. */
    const ident = { biz, id };
    const changed = lastIdent.current === null ||
      lastIdent.current.biz !== biz || lastIdent.current.id !== id;
    if (changed) {
      lastIdent.current = ident;
      setDlg(null);
      setMutNote(null);
      setMutBusy(false);
      ++opSeq.current;
    }
    setSt(biz ? { kind: "loading" } : { kind: "no-business" });
    if (!biz) return;
    const ctl = new AbortController();
    const forBiz = biz;
    const forId = id;
    (async () => {
      const [agentsR, contractR, policyR, inboxR, itemsR, graphR] = await Promise.allSettled([
        api.orgAgents(ctl.signal),
        api.agentContract(forId, ctl.signal),
        api.agentEffectivePolicy(forId, ctl.signal),
        api.agentInbox(forId, ctl.signal),
        api.workItems(forBiz, ctl.signal),
        api.businessWorkGraph(forBiz, ctl.signal),
      ]);
      if (ctl.signal.aborted) return;
      if (agentsR.status === "rejected") {
        const e = agentsR.reason;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
        return;
      }
      const agent = (agentsR.value.agents ?? []).find((a) => String(a.agent_id) === forId) ?? null;
      if (!agent) {
        setSt({ kind: "not-found" });
        return;
      }
      if (String(agent.business_id) !== forBiz) {
        /* foreign agent under this business — never render its fields */
        setSt({ kind: "foreign" });
        return;
      }
      setSt({
        kind: "ready",
        r: {
          forBiz,
          forId,
          agent,
          contract: sect(contractR, (v) => v.contract),
          policy: sect(policyR, (v) => v),
          inbox: sect(inboxR, (v) => (Array.isArray(v.messages) ? v.messages : null)),
          /* inbox read may return {state:"CORRUPT",corrupt:true} with no
             messages array — null marks the whole section corrupt */
          items: sect(itemsR, (v) => (Array.isArray(v.work_items) ? v.work_items : null)),
          graph: sect(graphR, (v) => v),
        },
      });
    })();
    return () => ctl.abort();
  }, [biz, id, tick]);

  const decide = () => {
    if (!dlg) return;
    const { op, agentId } = dlg;
    const seq = ++opSeq.current;
    setDlg(null);
    setMutBusy(true);
    setMutNote(null);
    const call =
      op === "pause" || op === "resume" || op === "terminate"
        ? api.orgAgentAction(agentId, op)
        : api.agentContractAction(agentId, op === "enable-contract" ? "enable" : "disable");
    call
      .then(() => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        setMutNote(`${OP_LABEL[op]} committed on ${agentId.slice(0, 18)} — canonical state refetched.`);
        setTick((n) => n + 1);
      })
      .catch((e: unknown) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        setMutNote(`${OP_LABEL[op]} failed: ${e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e)}`);
      });
  };

  /* ---------- guards / non-ready renders ---------- */
  if (st.kind === "no-business") {
    return (
      <>
        <h1>Agent Detail</h1>
        <EmptyState title="No business selected" detail="Select a business — agent identity is verified against the selected business." />
      </>
    );
  }
  if (st.kind === "error") {
    const { err } = st;
    return (
      <>
        <h1>Agent Detail</h1>
        {err.status === 401 ? (
          <ErrorState code={err.code || "UNAUTHORIZED"} detail="Your credentials were rejected — update the session token in Settings, then retry." onRetry={() => setTick((n) => n + 1)} />
        ) : err.status === 403 ? (
          <DeniedState detail={`Agent read denied: ${err.detail} (${err.code})`} />
        ) : (
          <ErrorState code={err.code} detail={err.detail} onRetry={() => setTick((n) => n + 1)} />
        )}
      </>
    );
  }
  if (st.kind === "not-found") {
    return (
      <>
        <h1>Agent Detail</h1>
        <EmptyState title="Agent not found" detail={`${id} is not present in the global org-agents read.`} />
        <Link className="go" to="/app/workforce">back to workforce →</Link>
      </>
    );
  }
  if (st.kind === "foreign") {
    return (
      <>
        <h1>Agent Detail</h1>
        <DeniedState detail={`${id} does not belong to the selected business — its fields are never rendered in this workspace.`} />
        <Link className="go" to="/app/workforce">back to workforce →</Link>
      </>
    );
  }
  /* synchronous render-boundary guard: ready data only paints when it
     belongs to the CURRENT route + selected business. */
  const ready =
    st.kind === "ready" &&
    st.r.forBiz === biz &&
    st.r.forId === id &&
    String(st.r.agent.business_id) === biz &&
    String(st.r.agent.agent_id) === id
      ? st.r
      : null;
  if (!ready) {
    return (
      <>
        <h1>Agent Detail</h1>
        <div className="sub">Loading {id}…</div>
        <div className="need">{[0, 1, 2].map((i) => <div className="nrow" key={i}><Skeleton height={12} width="55%" /></div>)}</div>
      </>
    );
  }

  const { agent, contract, policy, inbox, items, graph } = ready;

  /* legal UI gating mirrors backend authority (which stays final):
     ACTIVE → pause+terminate; PAUSED → resume+terminate; TERMINATED → none.
     Contract ops only when a materialized contract row exists with a
     defined status — enable/disable on a missing contract fails closed
     server-side, so the controls are hidden, not offered. */
  const ops: Op[] = [];
  if (agent.status === "ACTIVE") ops.push("pause", "terminate");
  else if (agent.status === "PAUSED") ops.push("resume", "terminate");
  const contractRow = contract.kind === "ready" ? contract.data : null;
  if (contractRow?.status === "ACTIVE") ops.push("disable-contract");
  else if (contractRow?.status === "DISABLED") ops.push("enable-contract");

  const assigned = items.kind === "ready" && Array.isArray(items.data)
    ? items.data.filter((w) => w.assignee_agent_id === id && !TERMINAL.has(w.status))
    : [];
  const delegatedIn = graph.kind === "ready"
    ? graph.data.delegations.filter((d) => String(d.delegated_to_agent_id) === id)
    : [];
  const delegatedOut = graph.kind === "ready"
    ? graph.data.delegations.filter((d) => String(d.delegated_by_agent_id) === id)
    : [];
  const inboxCorrupt = inbox.kind === "ready" && inbox.data === null;
  const messages = inbox.kind === "ready" && Array.isArray(inbox.data)
    ? [...inbox.data].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    : [];
  const pol = policy.kind === "ready" ? policy.data : null;

  return (
    <>
      <div className="chead">
        <div>
          <h1>{agent.title || id}</h1>
          <div className="sub">
            <code>{id}</code> · dept {agent.department || "—"}
            {agent.role ? ` · ${agent.role}` : ""}
          </div>
        </div>
        <StatusBadge tone={AGENT_TONE[agent.status] ?? "unknown"} label={agent.status} />
      </div>

      <div className="sub" style={{ marginBottom: 10 }}>
        Identity verified: business_id matches the selected business. Reads are
        canonical — contract, effective-policy, inbox, work-items, work-graph.
      </div>

      {mutNote ? <div className="trunc" role="status">{mutNote}</div> : null}

      {ops.length > 0 ? (
        <div className="actbar" role="group" aria-label="agent lifecycle actions">
          {ops.map((op) => (
            <button
              key={op}
              className={`tbtn${op === "terminate" ? " danger" : ""}`}
              disabled={mutBusy}
              onClick={() =>
                setDlg({ op, agentId: id, biz, label: OP_LABEL[op] })
              }
            >
              {OP_LABEL[op]}
            </button>
          ))}
        </div>
      ) : (
        <div className="sub" style={{ marginBottom: 10 }}>
          {agent.status === "TERMINATED" ? "Agent terminated — lifecycle controls hidden by this UI (UI-level gating only: the backend enforces status membership, not irreversibility)." : "No lifecycle operations available."}
        </div>
      )}

      <h2 className="sech">Execution contract</h2>
      <div className="need">
        {contract.kind === "unavailable" ? (
          <SectMissing code={contract.code} what="Contract read" />
        ) : contract.data === null ? (
          <div className="nrow">
            <span className="note">
              No contract materialized — enable/disable unavailable. Contract
              editing (including baseline materialization) is deferred to B5.2.
            </span>
          </div>
        ) : (
          <div className="nrow">
            <span className="tt"><code>{String(contract.data.contract_id).slice(0, 20)}</code></span>
            <StatusBadge tone={contract.data.status === "ACTIVE" ? "ok" : "warn"} label={contract.data.status} />
            <span className="note">
              v{contract.data.contract_version} · digest <code>{String(contract.data.contract_digest).slice(0, 14)}</code>
              {contract.data.updated_at ? ` · ${String(contract.data.updated_at).slice(0, 19).replace("T", " ")}` : ""}
            </span>
          </div>
        )}
      </div>

      <h2 className="sech">Effective policy</h2>
      <div className="need">
        {policy.kind === "unavailable" ? (
          <SectMissing code={policy.code} what="Effective-policy read" />
        ) : (
          <>
            <div className="nrow">
              <span className="tt">capabilities</span>
              <span className="note">
                {pol!.policy.allowed_capabilities === null
                  ? "unrestricted (null allow-set)"
                  : `allowed: ${pol!.policy.allowed_capabilities.join(", ") || "none"}`}
                {pol!.policy.denied_capabilities.length > 0
                  ? ` · denied: ${pol!.policy.denied_capabilities.join(", ")}`
                  : ""}
              </span>
            </div>
            <div className="nrow">
              <span className="tt">executors</span>
              <span className="note">
                {pol!.policy.allowed_executor_ids === null
                  ? "unrestricted"
                  : `allowed: ${pol!.policy.allowed_executor_ids.join(", ") || "none"}`}
                {pol!.policy.denied_executor_ids.length > 0
                  ? ` · denied: ${pol!.policy.denied_executor_ids.join(", ")}`
                  : ""}
                {pol!.policy.preferred_executor_ids.length > 0
                  ? ` · preferred: ${pol!.policy.preferred_executor_ids.join(", ")}`
                  : ""}
                {` · fallback ${pol!.policy.executor_fallback_allowed ? "allowed" : "denied"}`}
              </span>
            </div>
            <div className="nrow">
              <span className="tt">routes</span>
              <span className="note">
                {pol!.policy.preferred_route_ids.length > 0
                  ? `preferred: ${pol!.policy.preferred_route_ids.join(", ")}`
                  : "no preferred routes"}
                {pol!.policy.denied_route_ids.length > 0
                  ? ` · denied: ${pol!.policy.denied_route_ids.join(", ")}`
                  : ""}
                {` · fallback ${pol!.policy.route_fallback_allowed ? "allowed" : "denied"}`}
              </span>
            </div>
            <div className="nrow">
              <span className="tt">projects · scopes</span>
              <span className="note">
                {pol!.policy.allowed_project_ids === null
                  ? "projects unrestricted"
                  : `projects: ${pol!.policy.allowed_project_ids.join(", ") || "none"}`}
                {pol!.policy.allowed_context_scopes.length > 0
                  ? ` · scopes: ${pol!.policy.allowed_context_scopes.join(", ")}`
                  : " · no context scopes"}
              </span>
            </div>
            <div className="nrow">
              <span className="note">
                contract v{pol!.contract_version} · agent {pol!.agent_status} · contract {pol!.status}
              </span>
            </div>
          </>
        )}
      </div>

      <h2 className="sech">Current assignments</h2>
      <div className="need">
        {items.kind === "unavailable" ? (
          <SectMissing code={items.code} what="Work-item read" />
        ) : items.data === null ? (
          <div className="nrow"><span className="note">Work-item payload malformed — assignments unavailable (not zero).</span></div>
        ) : assigned.length === 0 ? (
          <div className="nrow"><span className="note">No active work items assigned to this agent.</span></div>
        ) : (
          assigned.map((w) => (
            <div className="nrow" key={w.work_item_id}>
              <span className="tt">{w.title || w.work_item_id}</span>
              <StatusBadge tone={WI_TONE[w.status] ?? "unknown"} label={w.status} />
              <span className="note">
                <code>{String(w.work_item_id).slice(0, 16)}</code>
                {w.objective_id ? ` · obj ${String(w.objective_id).slice(0, 14)}` : ""}
                {w.mission_ids.length > 0 ? ` · ${w.mission_ids.length} mission(s)` : ""}
                {w.dependencies_satisfied === false ? " · deps unproven" : ""}
              </span>
            </div>
          ))
        )}
        {graph.kind === "unavailable" ? (
          <SectMissing code={graph.code} what="Work-graph" />
        ) : (
          <>
            {delegatedIn.map((d, i) => (
              <div className="nrow" key={`din-${i}`}>
                <StatusBadge tone="info" label="delegated in" />
                <span className="tt"><code>{String(d.child_work_item_id ?? d.work_item_id ?? "").slice(0, 18)}</code></span>
                <span className="note">from <code>{String(d.delegated_by_agent_id ?? "").slice(0, 16)}</code></span>
              </div>
            ))}
            {delegatedOut.map((d, i) => (
              <div className="nrow" key={`dout-${i}`}>
                <StatusBadge tone="info" label="delegated out" />
                <span className="tt"><code>{String(d.child_work_item_id ?? d.work_item_id ?? "").slice(0, 18)}</code></span>
                <span className="note">to <code>{String(d.delegated_to_agent_id ?? "").slice(0, 16)}</code></span>
              </div>
            ))}
          </>
        )}
      </div>

      <h2 className="sech">Inbox</h2>
      <div className="need">
        {inbox.kind === "unavailable" ? (
          <SectMissing code={inbox.code} what="Inbox read" />
        ) : inboxCorrupt ? (
          <div className="nrow">
            <StatusBadge tone="danger" label="CORRUPT" />
            <span className="note">canonical inbox corrupt — messages withheld, never rendered as empty</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="nrow"><span className="note">No messages in this agent's durable inbox.</span></div>
        ) : (
          messages.slice(0, 50).map((m) => (
            <div className="nrow" key={m.message_id}>
              <StatusBadge
                tone={m.corrupt || m.state === "CORRUPT" ? "danger" : m.receipt_status === "PENDING" ? "warn" : "ok"}
                label={m.corrupt || m.state === "CORRUPT" ? "CORRUPT" : (m.receipt_status ?? "—")}
              />
              <span className="tt">{m.kind || "message"}</span>
              <span className="note">
                {m.corrupt ? "canonical message corrupt — body withheld" : m.body}
                {" · "}
                {String(m.created_at).slice(0, 19).replace("T", " ")}
                {m.work_item_id ? ` · wi ${String(m.work_item_id).slice(0, 14)}` : ""}
              </span>
            </div>
          ))
        )}
      </div>

      <ConfirmDialog
        open={dlg !== null && dlg.biz === biz && dlg.agentId === id}
        title={dlg?.label ?? ""}
        body={dlg?.op === "terminate"
          ? `TERMINATE ${dlg.agentId}? High-risk: commits the canonical terminate mutation. This UI hides lifecycle actions for a TERMINATED agent — UI-level gating only: the backend enforces status membership, NOT an irreversible transition (a resume POST remains a valid backend call). Backend authority remains final.`
          : `${dlg?.label} on ${dlg?.agentId ?? ""}? This commits the existing canonical mutation on the backend — no client-side state is assumed beforehand.`}
        confirmLabel={dlg?.op === "terminate" ? "Terminate" : "Confirm"}
        busy={mutBusy}
        onConfirm={decide}
        onCancel={() => setDlg(null)}
      >
        {dlg ? (
          <dl className="dmeta">
            <dt>agent</dt><dd><code>{dlg.agentId}</code></dd>
            <dt>business</dt><dd><code>{dlg.biz}</code></dd>
            <dt>operation</dt><dd>{dlg.label}</dd>
            <dt>authority</dt><dd>backend transition — POST only after this confirmation; canonical refetch on success</dd>
          </dl>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
