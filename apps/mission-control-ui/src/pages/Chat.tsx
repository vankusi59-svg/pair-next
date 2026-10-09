import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, getOperatorId } from "../api";
import { useApi } from "../hooks/useApi";
import type {
  ConversationMessage,
  ConversationSession,
  MissionDraft,
} from "../types";

/* P15.8-D — Chat mode. Natural multi-turn conversation on the canonical
 * conversation services: operator turns through ConversationReasoning
 * (codex-cli lane), governed mission drafts through MissionDraftService.
 * Chat text is NEVER execution authority — a mission only starts when the
 * operator explicitly confirms a displayed draft (exact id + digest). */

const RISK_LEVELS = ["", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
/* Canonical page size — mirrors CONVERSATION_MAX_PAGE_SIZE server-side.
 * The thread window is the TAIL page: sessions with >PAGE messages
 * open at the newest end (session.next_seq tells us where it is), and
 * earlier history is reachable through the bounded "Load earlier"
 * walk — never an unbounded full-history fetch. */
const MSG_PAGE = 200;

function DraftCard({
  draft,
  sessionId,
  onChanged,
  onRevise,
  setErr,
}: {
  draft: MissionDraft;
  sessionId: string;
  onChanged: () => void;
  onRevise: (d: MissionDraft) => void;
  setErr: (e: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const pending = draft.state === "PENDING_CONFIRMATION";
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`draft-card st-${draft.state.toLowerCase()}`} data-draft-id={draft.draft_id}>
      <div className="row" style={{ justifyContent: "space-between", margin: 0 }}>
        <strong>GOVERNED MISSION DRAFT</strong>
        <span className={`badge ${pending ? "b-waiting" : draft.state === "CONFIRMED" ? "b-ok" : "b-fail"}`}>
          {draft.state}
        </span>
      </div>
      <p className="muted" style={{ margin: "6px 0" }}>
        A draft is a proposal — nothing runs until you confirm this exact draft.
      </p>
      <table className="tbl">
        <tbody>
          <tr><td className="muted">draft</td><td className="mono">{draft.draft_id}</td></tr>
          <tr><td className="muted">digest</td><td className="mono">{draft.draft_digest.slice(0, 24)}…</td></tr>
          <tr><td className="muted">project</td><td className="mono">{draft.project_id}</td></tr>
          <tr><td className="muted">goal</td><td className="goal">{draft.goal}</td></tr>
          <tr><td className="muted">permissions</td><td className="mono">{draft.granted_permissions.join(", ") || "—"}</td></tr>
          <tr><td className="muted">workspaces</td><td className="mono">{(draft.authorized_workspaces ?? []).join(", ") || "—"}</td></tr>
          <tr><td className="muted">risk ceiling</td><td className="mono">{draft.risk_ceiling ?? "system default"}</td></tr>
          <tr><td className="muted">expires</td><td className="mono">{draft.expires_at}</td></tr>
        </tbody>
      </table>
      {draft.mission_id && (
        <p>
          Mission: <Link to={`/missions/${draft.mission_id}`} className="mono">{draft.mission_id}</Link>
        </p>
      )}
      {pending && (
        <div className="row">
          <button
            disabled={busy}
            onClick={() =>
              // Confirmation binds THIS displayed draft_id + draft_digest —
              // never a re-resolved "latest" proposal.
              act(() => api.confirmDraft(sessionId, draft.draft_id, draft.draft_digest))
            }
          >
            Confirm this draft
          </button>
          <button className="ghost" disabled={busy} onClick={() => onRevise(draft)}>
            Revise (new draft)
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => act(() => api.rejectDraft(sessionId, draft.draft_id))}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

interface DraftForm {
  project_id: string;
  goal: string;
  risk_ceiling: string;
  supersedes_draft_id: string | null;
}

export function Chat() {
  const projects = useApi(() => api.projects());
  const [params, setParams] = useSearchParams();
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(params.get("s"));
  const [active, setActive] = useState<ConversationSession | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [drafts, setDrafts] = useState<MissionDraft[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [oldestSeq, setOldestSeq] = useState<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [draftForm, setDraftForm] = useState<DraftForm | null>(null);
  // P15.8-F — a model proposal that could not resolve a project: the
  // operator picks one here, then the existing canonical POST /drafts
  // mints it. A resolved proposal already landed as a real draft below.
  const [pendingProposal, setPendingProposal] = useState<{
    goal: string;
    candidates: { project_id: string; name: string }[];
    project_id: string;
  } | null>(null);

  const showErr = (e: unknown) =>
    setErr(e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e));

  const loadSessions = async (keepActive = true) => {
    try {
      const r = await api.conversations();
      setSessions(r.sessions);
      if (keepActive && activeId && !r.sessions.some((s) => s.session_id === activeId)) {
        setActiveId(null);
      }
    } catch (e) {
      showErr(e);
    } finally {
      setLoadingSessions(false);
    }
  };

  const loadThread = async (id: string) => {
    setLoadingThread(true);
    setErr(null);
    try {
      const [s, ds] = await Promise.all([
        api.conversation(id),
        api.conversationDrafts(id),
      ]);
      setActive(s.session);
      // Tail window: open at the NEWEST committed page (session.next_seq-1
      // is the last seq), so long histories never trigger an unbounded
      // fetch and the newest operator/assistant rows always render.
      const lastSeq = Math.max(0, s.session.next_seq - 1);
      const after = Math.max(0, lastSeq - MSG_PAGE);
      const ms = await api.conversationMessages(id, { after_seq: after, limit: MSG_PAGE });
      setMessages(ms.messages);
      setOldestSeq(ms.messages.length > 0 ? ms.messages[0]!.seq : null);
      setDrafts(ds.drafts);
    } catch (e) {
      setActive(null);
      setMessages([]);
      setOldestSeq(null);
      setDrafts([]);
      showErr(e);
    } finally {
      setLoadingThread(false);
    }
  };

  const loadEarlier = async () => {
    if (!activeId || oldestSeq === null || oldestSeq <= 1 || loadingEarlier) return;
    setLoadingEarlier(true);
    setErr(null);
    try {
      // The canonical pagination contract is strictly forward-only
      // (seq > after_seq, bounded pages): asking for the page that ENDS
      // just before our oldest row yields the previous window.
      const ms = await api.conversationMessages(activeId, {
        after_seq: Math.max(0, oldestSeq - 1 - MSG_PAGE),
        limit: MSG_PAGE,
      });
      setMessages((cur) => {
        const seen = new Set(cur.map((m) => m.message_id));
        const earlier = ms.messages.filter((m) => m.seq < oldestSeq && !seen.has(m.message_id));
        return [...earlier, ...cur];
      });
      setOldestSeq((cur) => {
        const earlier = ms.messages.filter((m) => cur !== null && m.seq < cur);
        return earlier.length > 0 ? Math.min(...earlier.map((m) => m.seq)) : cur;
      });
    } catch (e) {
      showErr(e);
    } finally {
      setLoadingEarlier(false);
    }
  };

  useEffect(() => {
    if (!getOperatorId()) {
      setErr("Set an operator id (top-right) first — conversations are owner-scoped.");
    }
    void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setParams(activeId ? { s: activeId } : {}, { replace: true });
    if (activeId) void loadThread(activeId);
    else {
      setActive(null);
      setMessages([]);
      setDrafts([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const newSession = async () => {
    setErr(null);
    try {
      const r = await api.createConversation({});
      await loadSessions();
      setActiveId(r.session.session_id);
    } catch (e) {
      showErr(e);
    }
  };

  const send = async () => {
    if (!activeId || !body.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const text = body;
    try {
      // One canonical turn: the operator message and the assistant reply
      // are committed by the reasoning service — a retry of the same
      // request replays the same rows (turn idempotency).
      const r = await api.conversationTurn(activeId, { body: text });
      setBody("");
      if (r.proposal?.project_candidates && r.proposal.project_candidates.length > 0) {
        setPendingProposal({
          goal: r.proposal.goal,
          candidates: r.proposal.project_candidates,
          project_id: "",
        });
      } else {
        setPendingProposal(null);
      }
      if (r.proposal?.rejected) {
        setErr(`Proposal could not become a draft: ${r.proposal.rejected}`);
      }
      await loadThread(activeId);
    } catch (e) {
      showErr(e);
    } finally {
      setBusy(false);
    }
  };

  const closeSession = async () => {
    if (!activeId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.closeConversation(activeId);
      await loadSessions();
      await loadThread(activeId);
    } catch (e) {
      showErr(e);
    } finally {
      setBusy(false);
    }
  };

  const openDraftForm = (revise?: MissionDraft) => {
    const lastOperator = [...messages].reverse().find((m) => m.role === "operator");
    setDraftForm({
      project_id: revise?.project_id ?? "",
      goal: revise?.goal ?? lastOperator?.body ?? "",
      risk_ceiling: revise?.risk_ceiling ?? "",
      supersedes_draft_id: revise?.draft_id ?? null,
    });
  };

  const submitDraft = async () => {
    if (!activeId || !draftForm || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const proj = (projects.data ?? []).find(
        (p) => String(p.project_id) === draftForm.project_id);
      await api.createDraft(activeId, {
        project_id: draftForm.project_id,
        goal: draftForm.goal,
        granted_permissions: ["FILE_WRITE", "FILE_READ"],
        authorized_workspaces: proj ? [String(proj.root_location)] : [],
        risk_ceiling: draftForm.risk_ceiling || undefined,
        supersedes_draft_id: draftForm.supersedes_draft_id ?? undefined,
      });
      setDraftForm(null);
      await loadThread(activeId);
    } catch (e) {
      showErr(e);
    } finally {
      setBusy(false);
    }
  };

  const refresh = () => activeId && void loadThread(activeId);

  return (
    <div className="page chat-page">
      <div className="chat-wrap">
        <aside className="chat-sessions" aria-label="conversations">
          <div className="row" style={{ margin: "0 0 8px" }}>
            <button className="ghost" onClick={newSession}>+ New chat</button>
          </div>
          {loadingSessions ? (
            <div className="state">Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="state empty">No conversations yet</div>
          ) : (
            <ul className="session-list">
              {sessions.map((s) => (
                <li key={s.session_id}>
                  <button
                    className={`ghost session-item ${s.session_id === activeId ? "on" : ""}`}
                    onClick={() => setActiveId(s.session_id)}
                  >
                    <span className="session-title">
                      {s.title || s.session_id.slice(0, 18)}
                    </span>
                    <span className="muted mono">{s.state} · {s.message_count} msg</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className="chat-main">
          {!activeId ? (
            <div className="state empty">
              Pick a conversation or start a new one. Chat is for talking —
              nothing here executes until you confirm a mission draft, and
              Task Entry stays the direct governed path.
            </div>
          ) : (
            <>
              <div className="chat-head">
                <div>
                  <h1 style={{ margin: 0, fontSize: 16 }}>
                    {active?.title || active?.session_id || activeId}
                  </h1>
                  <span className="muted mono">
                    {active?.state} · conversation mode — text is never authority
                  </span>
                </div>
                {active?.state === "OPEN" && (
                  <button className="ghost" onClick={closeSession} disabled={busy}>
                    Close session
                  </button>
                )}
              </div>
              {err && <div className="state err" style={{ padding: 12 }}>{err}</div>}
              <div className="chat-thread" role="log" aria-label="messages">
                {loadingThread ? (
                  <div className="state">Loading…</div>
                ) : messages.length === 0 ? (
                  <div className="state empty">No messages — say something.</div>
                ) : (
                  <>
                    {oldestSeq !== null && oldestSeq > 1 && (
                      <button
                        className="ghost"
                        style={{ alignSelf: "center" }}
                        disabled={loadingEarlier}
                        onClick={loadEarlier}
                      >
                        {loadingEarlier ? "Loading…" : `Load earlier (before seq ${oldestSeq})`}
                      </button>
                    )}
                    {messages.map((m) => (
                    <div key={m.message_id} className={`msg role-${m.role}`}>
                      <div className="msg-meta muted mono">
                        {m.role === "assistant" ? "PAIR · assistant" : m.role === "system" ? "system" : "you"} · seq {m.seq}
                      </div>
                      <div className="msg-body">{m.body}</div>
                    </div>
                    ))}
                  </>
                )}
                {busy && <div className="state">PAIR is thinking…</div>}
              </div>
              {pendingProposal && (
                <div className="draft-card st-pending_confirmation">
                  <strong>MISSION PROPOSAL — chọn project</strong>
                  <p className="muted" style={{ margin: "6px 0" }}>
                    The assistant proposed a mission but multiple projects exist.
                    Pick the project to mint a governed draft — nothing runs yet.
                  </p>
                  <p className="goal">{pendingProposal.goal}</p>
                  <div className="row">
                    <select
                      value={pendingProposal.project_id}
                      onChange={(e) =>
                        setPendingProposal({ ...pendingProposal, project_id: e.target.value })}
                    >
                      <option value="">— pick a project —</option>
                      {pendingProposal.candidates.map((c) => (
                        <option key={c.project_id} value={c.project_id}>
                          {c.name} ({c.project_id})
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={busy || !pendingProposal.project_id}
                      onClick={async () => {
                        if (!activeId || !pendingProposal.project_id) return;
                        setBusy(true);
                        setErr(null);
                        try {
                          const proj = (projects.data ?? []).find(
                            (p) => String(p.project_id) === pendingProposal.project_id);
                          await api.createDraft(activeId, {
                            project_id: pendingProposal.project_id,
                            goal: pendingProposal.goal,
                            granted_permissions: ["FILE_WRITE", "FILE_READ"],
                            authorized_workspaces: proj ? [String(proj.root_location)] : [],
                          });
                          setPendingProposal(null);
                          await loadThread(activeId);
                        } catch (e) {
                          showErr(e);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Create draft
                    </button>
                    <button className="ghost" onClick={() => setPendingProposal(null)}>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
              {drafts.length > 0 && (
                <div className="chat-drafts">
                  <h2 style={{ marginTop: 8 }}>Mission drafts</h2>
                  {drafts.map((d) => (
                    <DraftCard
                      key={d.draft_id}
                      draft={d}
                      sessionId={activeId}
                      onChanged={refresh}
                      onRevise={openDraftForm}
                      setErr={setErr}
                    />
                  ))}
                </div>
              )}
              {active?.state === "OPEN" && (
                <>
                  {draftForm ? (
                    <div className="draft-form">
                      <h2 style={{ marginTop: 8 }}>
                        {draftForm.supersedes_draft_id
                          ? `Revise draft ${draftForm.supersedes_draft_id.slice(0, 14)}…`
                          : "Prepare a mission draft"}
                      </h2>
                      <p className="muted">
                        The draft pins the exact terms you will confirm. Editing
                        later mints a NEW draft — the old digest is invalidated.
                      </p>
                      <label htmlFor="draft-goal">Mission goal</label>
                      <textarea
                        id="draft-goal"
                        rows={3}
                        value={draftForm.goal}
                        onChange={(e) => setDraftForm({ ...draftForm, goal: e.target.value })}
                      />
                      <label htmlFor="draft-project">Project</label>
                      <select
                        id="draft-project"
                        value={draftForm.project_id}
                        onChange={(e) => setDraftForm({ ...draftForm, project_id: e.target.value })}
                      >
                        <option value="">— pick a project —</option>
                        {(projects.data ?? []).map((p) => (
                          <option key={String(p.project_id)} value={String(p.project_id)}>
                            {String(p.name)} ({String(p.root_location)})
                          </option>
                        ))}
                      </select>
                      <label htmlFor="draft-risk">Risk ceiling</label>
                      <select
                        id="draft-risk"
                        value={draftForm.risk_ceiling}
                        onChange={(e) => setDraftForm({ ...draftForm, risk_ceiling: e.target.value })}
                      >
                        {RISK_LEVELS.map((r) => (
                          <option key={r} value={r}>{r || "system default (HIGH)"}</option>
                        ))}
                      </select>
                      <div className="row">
                        <button
                          disabled={busy || !draftForm.goal.trim() || !draftForm.project_id}
                          onClick={submitDraft}
                        >
                          {busy ? "Creating…" : draftForm.supersedes_draft_id ? "Create revised draft" : "Create draft"}
                        </button>
                        <button className="ghost" onClick={() => setDraftForm(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : null}
                  <div className="composer">
                    <textarea
                      id="composer"
                      aria-label="message"
                      rows={3}
                      value={body}
                      placeholder="Nhắn tin… (chat is conversation only — it never executes)"
                      onChange={(e) => setBody(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
                      }}
                    />
                    <div className="row" style={{ marginTop: 0 }}>
                      <button onClick={send} disabled={busy || !body.trim()}>
                        {busy ? "Sending…" : "Send"}
                      </button>
                      {!draftForm && (
                        <button className="ghost" onClick={() => openDraftForm()}>
                          Prepare mission draft
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
