import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, apiAdmin } from "../../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState, ErrorState, Skeleton } from "../components/states";
import { StatusBadge } from "../components/StatusBadge";
import type {
  ConversationMessage,
  ConversationSession,
  ConversationTurnResult,
  MissionDraft,
} from "../../types";

/* ==========================================================================
   P15.9-B5.4 — /app/chat (Conversation layer, canonical P15.8 contract)

   CENTRAL INVARIANT: conversation text is never execution authority. A
   mission may execute only through the existing canonical mission-draft
   confirmation contract — a chat turn mints at most a PENDING draft;
   only an explicit pinned {session_id, draft_id, expected_digest}
   confirmation POST can execute.

   Request-lifecycle rules baked in:
   - every read kind has its own AbortController + generation guard
   - mutation POSTs that may have committed are NEVER aborted/forgotten:
     ambiguous outcome is surfaced honestly, no auto-retry
   - session switching invalidates A's display state instantly; a late A
     response is gated by session id + generation and cannot paint into B
   ========================================================================== */

const MSG_PAGE = 200;
const DRAFT_STATES = new Set([
  "PENDING_CONFIRMATION",
  "SUBMITTING",
  "CONFIRMED",
  "REJECTED",
  "EXPIRED",
  "SUBMISSION_EXPIRED",
]);
const MSG_ROLES = new Set(["operator", "assistant", "system"]);
const SESSION_STATES = new Set(["OPEN", "CLOSED"]);
const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

type ApiFail = { code: string; detail: string; status?: number };
const failOf = (e: unknown): ApiFail =>
  e instanceof ApiError
    ? { code: e.code, detail: e.detail, status: e.status }
    : e instanceof Error
      ? { code: "ERROR", detail: e.message }
      : { code: "ERROR", detail: String(e) };

const MALFORMED: ApiFail = {
  code: "MALFORMED",
  detail:
    "The canonical response failed element validation — withheld instead of rendered as fabricated data.",
};

type Sec<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "error"; err: ApiFail };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/* ---- element validators — an invalid row never silently drops into a
   complete-looking list; the whole collection goes MALFORMED. ---- */

function validSession(v: unknown): v is ConversationSession {
  if (!isObj(v)) return false;
  if (typeof v.session_id !== "string" || !v.session_id) return false;
  if (typeof v.state !== "string" || !SESSION_STATES.has(v.state)) return false;
  if (typeof v.next_seq !== "number" || !Number.isInteger(v.next_seq) || v.next_seq < 1)
    return false;
  if (v.message_count !== undefined &&
      (typeof v.message_count !== "number" || !Number.isInteger(v.message_count) || v.message_count < 0))
    return false;
  if (typeof v.owner_operator_id !== "string" || !v.owner_operator_id) return false;
  return true;
}

function validMessage(v: unknown, sessionId: string): v is ConversationMessage {
  if (!isObj(v)) return false;
  if (typeof v.message_id !== "string" || !v.message_id) return false;
  if (v.session_id !== sessionId) return false;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 1) return false;
  if (typeof v.role !== "string" || !MSG_ROLES.has(v.role)) return false;
  if (typeof v.body !== "string") return false;
  if (typeof v.created_at !== "string") return false;
  return true;
}

function validDraft(v: unknown, sessionId: string): v is MissionDraft {
  if (!isObj(v)) return false;
  if (typeof v.draft_id !== "string" || !v.draft_id) return false;
  if (v.session_id !== sessionId) return false;
  if (typeof v.state !== "string" || !DRAFT_STATES.has(v.state)) return false;
  if (typeof v.draft_digest !== "string" || !v.draft_digest) return false;
  if (typeof v.project_id !== "string" || !v.project_id) return false;
  if (typeof v.goal !== "string") return false;
  if (!Array.isArray(v.granted_permissions) ||
      (v.granted_permissions as unknown[]).some((p) => typeof p !== "string"))
    return false;
  if (v.authorized_workspaces != null &&
      (!Array.isArray(v.authorized_workspaces) ||
        (v.authorized_workspaces as unknown[]).some((w) => typeof w !== "string")))
    return false;
  return true;
}

function validProject(v: unknown): v is { project_id: string; name?: string } {
  return isObj(v) && typeof v.project_id === "string" && !!v.project_id;
}

const draftExpired = (d: MissionDraft): boolean => {
  if (!d.expires_at) return false;
  const t = Date.parse(d.expires_at);
  return Number.isFinite(t) && t <= Date.now();
};

const draftConfirmable = (d: MissionDraft): boolean =>
  d.state === "PENDING_CONFIRMATION" && !draftExpired(d);

/* A draft card renders exactly the canonical fields it was persisted with —
   no invented permissions/workspaces, no optimistic state. */
function DraftTerms({ d }: { d: MissionDraft }) {
  return (
    <dl className="dmeta">
      <dt>draft_id</dt>
      <dd className="mono">{d.draft_id}</dd>
      <dt>digest</dt>
      <dd className="mono trunc" title={d.draft_digest}>{d.draft_digest}</dd>
      <dt>project</dt>
      <dd className="mono">{d.project_id}</dd>
      <dt>goal</dt>
      <dd>{d.goal}</dd>
      <dt>permissions</dt>
      <dd>{d.granted_permissions.length ? d.granted_permissions.join(", ") : "— none granted —"}</dd>
      <dt>workspaces</dt>
      <dd>{d.authorized_workspaces?.length ? d.authorized_workspaces.join(", ") : "— inherit project root (canonical default) —"}</dd>
      <dt>risk ceiling</dt>
      <dd>{d.risk_ceiling ?? "— canonical default (HIGH) —"}</dd>
      <dt>expires_at</dt>
      <dd className="mono">{d.expires_at ?? "—"}</dd>
      {d.supersedes_draft_id ? (<><dt>supersedes</dt><dd className="mono">{d.supersedes_draft_id}</dd></>) : null}
    </dl>
  );
}

function draftTone(d: MissionDraft) {
  switch (d.state) {
    case "CONFIRMED": return "ok" as const;
    case "PENDING_CONFIRMATION": return draftExpired(d) ? "danger" as const : "warn" as const;
    case "SUBMITTING": return "info" as const;
    case "REJECTED": case "EXPIRED": case "SUBMISSION_EXPIRED": return "danger" as const;
    default: return "unknown" as const;
  }
}

/* The pinned identity of a mutation dialog — the digest/ids shown are the
   exact ones submitted, never re-read from a newer fetch. */
type Dialog =
  | { op: "confirm"; sessionId: string; draft: MissionDraft }
  | { op: "reject"; sessionId: string; draft: MissionDraft }
  | { op: "close"; sessionId: string; title?: string };

/* A proposal that resolved ambiguous server-side: explicit project choice
   is required, and every candidate is re-validated against the canonical
   GET /api/projects read before a draft can be created. */
type PendingProposal = {
  messageId: string;
  goal: string;
  candidates: { project_id: string; name: string }[];
};

export default function Chat() {
  const [params, setParams] = useSearchParams();
  const activeId = params.get("s");

  /* ---- session list (its own request owner) ---- */
  const [sessions, setSessions] = useState<Sec<ConversationSession[]>>({ kind: "loading" });
  const sessionsReq = useRef<{ id: number; ctl: AbortController } | null>(null);
  const sessionsSeq = useRef(0);

  /* ---- active thread (its own request owner, generation-guarded) ---- */
  const [thread, setThread] = useState<
    Sec<{ session: ConversationSession; messages: ConversationMessage[]; oldestSeq: number }>
  >({ kind: "loading" });
  const threadReq = useRef<{ ctl: AbortController; sessionId: string } | null>(null);
  const gen = useRef(0); // bumped on every session switch / invalidate
  const activeRef = useRef<string | null>(activeId); // live mirror for late responses

  /* ---- earlier-page loads (separate owner, pinned to session+gen) ---- */
  const [earlierBusy, setEarlierBusy] = useState(false);
  const [earlierErr, setEarlierErr] = useState<ApiFail | null>(null);
  const earlierReq = useRef<{ ctl: AbortController; sessionId: string; g: number } | null>(null);

  /* ---- drafts (separate read owner) ---- */
  const [draftsSec, setDraftsSec] = useState<Sec<MissionDraft[]>>({ kind: "loading" });
  const draftsReq = useRef<{ ctl: AbortController; sessionId: string; g: number } | null>(null);

  /* ---- composer / turn (mutation — NEVER aborted) ---- */
  const [body, setBody] = useState("");
  const [turnBusy, setTurnBusy] = useState(false);
  const [turnNote, setTurnNote] = useState<string | null>(null);
  const turnFlight = useRef<{ sessionId: string; g: number; key: string } | null>(null);
  /* Retained across navigation: retry reuses original key+body+session. */
  const pendingSubmit = useRef<{ sessionId: string; body: string; key: string } | null>(null);

  /* ---- proposal + draft form ---- */
  const [proposal, setProposal] = useState<PendingProposal | null>(null);
  /* F2 — ref mirror so in-flight project validation can gate on the
     EXACT proposing message it was fetched for. */
  const proposalRef = useRef<PendingProposal | null>(null);
  const setProp = useCallback((p: PendingProposal | null) => {
    proposalRef.current = p;
    setProposal(p);
  }, []);
  const [proposalProjects, setProposalProjects] = useState<Sec<{ project_id: string; name?: string }[]> | null>(null);
  const [proposalPick, setProposalPick] = useState("");
  const projectsReq = useRef<AbortController | null>(null);
  const [draftForm, setDraftForm] = useState<{
    open: boolean; goal: string; projectId: string; supersedes: string | null;
    permissions: string; workspaces: string; risk: string;
  }>({ open: false, goal: "", projectId: "", supersedes: null, permissions: "", workspaces: "", risk: "" });
  const [draftFormProjects, setDraftFormProjects] = useState<Sec<{ project_id: string; name?: string }[]> | null>(null);
  const draftFormReq = useRef<AbortController | null>(null);

  /* ---- mutations (single-flight per op; never aborted) ---- */
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [mutBusy, setMutBusy] = useState<string | null>(null); // `${op}:${id}` of in-flight mutation
  const mutFlight = useRef<string | null>(null);
  const [mutNote, setMutNote] = useState<string | null>(null);
  const [confirmedMission, setConfirmedMission] = useState<{ sessionId: string; missionId: string } | null>(null);
  const [newTitle, setNewTitle] = useState("");

  /* ============================ data loaders ============================ */

  const loadSessions = useCallback(() => {
    sessionsReq.current?.ctl.abort();
    const id = ++sessionsSeq.current;
    const ctl = new AbortController();
    sessionsReq.current = { id, ctl };
    setSessions((s) => (s.kind === "ready" ? s : { kind: "loading" }));
    apiAdmin
      .conversations(ctl.signal)
      .then((r) => {
        if (sessionsSeq.current !== id) return;
        if (!isObj(r) || !Array.isArray(r.sessions)) return setSessions({ kind: "error", err: MALFORMED });
        if (!r.sessions.every(validSession)) return setSessions({ kind: "error", err: MALFORMED });
        setSessions({ kind: "ready", value: r.sessions });
      })
      .catch((e) => {
        if (sessionsSeq.current !== id) return;
        setSessions({ kind: "error", err: failOf(e) });
      });
  }, []);

  const loadDrafts = useCallback((sessionId: string) => {
    draftsReq.current?.ctl.abort();
    const g = gen.current;
    const ctl = new AbortController();
    draftsReq.current = { ctl, sessionId, g };
    setDraftsSec((s) => (s.kind === "ready" ? s : { kind: "loading" }));
    apiAdmin
      .conversationDrafts(sessionId, ctl.signal)
      .then((r) => {
        if (gen.current !== g || activeRef.current !== sessionId) return;
        if (!isObj(r) || !Array.isArray(r.drafts)) return setDraftsSec({ kind: "error", err: MALFORMED });
        if (!r.drafts.every((d) => validDraft(d, sessionId)))
          return setDraftsSec({ kind: "error", err: MALFORMED });
        setDraftsSec({ kind: "ready", value: r.drafts });
      })
      .catch((e) => {
        if (gen.current !== g || activeRef.current !== sessionId) return;
        setDraftsSec({ kind: "error", err: failOf(e) });
      });
  }, []);

  const loadThread = useCallback((sessionId: string) => {
    threadReq.current?.ctl.abort();
    const g = gen.current;
    const ctl = new AbortController();
    threadReq.current = { ctl, sessionId };
    setThread({ kind: "loading" });
    apiAdmin
      .conversation(sessionId, ctl.signal)
      .then(async (r) => {
        if (gen.current !== g || activeRef.current !== sessionId) return;
        if (!isObj(r) || !validSession(r.session)) return setThread({ kind: "error", err: MALFORMED });
        const session = r.session;
        const lastSeq = session.next_seq - 1;
        const after = Math.max(0, lastSeq - MSG_PAGE);
        const mr = await apiAdmin.conversationMessages(sessionId, { after_seq: after, limit: MSG_PAGE }, ctl.signal);
        if (gen.current !== g || activeRef.current !== sessionId) return;
        if (!isObj(mr) || !Array.isArray(mr.messages)) return setThread({ kind: "error", err: MALFORMED });
        if (!mr.messages.every((m) => validMessage(m, sessionId)))
          return setThread({ kind: "error", err: MALFORMED });
        const sorted = [...mr.messages].sort((a, b) => a.seq - b.seq);
        const oldestSeq = sorted.length ? sorted[0]!.seq : 1;
        setThread({ kind: "ready", value: { session, messages: sorted, oldestSeq } });
      })
      .catch((e) => {
        if (gen.current !== g || activeRef.current !== sessionId) return;
        if (ctl.signal.aborted) return;
        setThread({ kind: "error", err: failOf(e) });
      });
  }, []);

  /* Session switch: instantly invalidate A's display state, abort A's
     reads, bump the generation so late A responses can never paint into
     B's messages/drafts/proposal/loading/errors. Mutation POSTs keep
     flying (they may have committed) pinned to their original session. */
  useEffect(() => {
    activeRef.current = activeId;
    gen.current += 1;
    threadReq.current?.ctl.abort();
    earlierReq.current?.ctl.abort();
    draftsReq.current?.ctl.abort();
    projectsReq.current?.abort();
    draftFormReq.current?.abort();
    setEarlierBusy(false);
    setEarlierErr(null);
    setTurnNote(null);
    setMutNote(null);
    /* F1 — composer text belongs to a session: switching sessions clears
       it so A's unsent text is never displayed or sent under B. The
       pendingSubmit {sessionId,body,key} survives — an ambiguous in-flight
       turn keeps its idempotent retry identity for when A is revisited. */
    setBody("");
    setProp(null);
    setProposalProjects(null);
    setProposalPick("");
    setConfirmedMission(null);
    setDialog(null);
    setDraftForm({ open: false, goal: "", projectId: "", supersedes: null, permissions: "", workspaces: "", risk: "" });
    setDraftFormProjects(null);
    if (!activeId) {
      setThread({ kind: "error", err: { code: "NO_SESSION", detail: "" } });
      setDraftsSec({ kind: "loading" });
      return;
    }
    loadThread(activeId);
    loadDrafts(activeId);
  }, [activeId, loadThread, loadDrafts]);

  useEffect(() => {
    loadSessions();
    return () => {
      sessionsReq.current?.ctl.abort();
      threadReq.current?.ctl.abort();
      earlierReq.current?.ctl.abort();
      draftsReq.current?.ctl.abort();
      projectsReq.current?.abort();
      draftFormReq.current?.abort();
    };
  }, [loadSessions]);

  /* ============================ session ops ============================ */

  const pickSession = (id: string) => {
    if (id === activeId) return;
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("s", id);
      return n;
    });
  };

  const createSession = () => {
    if (mutFlight.current) return;
    mutFlight.current = "new-session";
    setMutBusy("new-session");
    apiAdmin
      .createConversation({ title: newTitle.trim() || undefined })
      .then((r) => {
        setMutBusy(null);
        mutFlight.current = null;
        if (!isObj(r) || !validSession(r.session)) return setMutNote("New conversation response was malformed — refresh the list.");
        setNewTitle("");
        loadSessions();
        pickSession(r.session.session_id);
      })
      .catch((e) => {
        setMutBusy(null);
        mutFlight.current = null;
        setMutNote(`Create conversation may not have committed (${failOf(e).code}) — refresh the list before retrying.`);
      });
  };

  /* ============================ thread ops ============================ */

  const loadEarlier = () => {
    if (thread.kind !== "ready" || earlierBusy || !activeId) return;
    const sessionId = activeId;
    const g = gen.current;
    const t = thread.value;
    const after = Math.max(0, t.oldestSeq - 1 - MSG_PAGE);
    const ctl = new AbortController();
    earlierReq.current = { ctl, sessionId, g };
    setEarlierBusy(true);
    setEarlierErr(null);
    apiAdmin
      .conversationMessages(sessionId, { after_seq: after, limit: MSG_PAGE }, ctl.signal)
      .then((r) => {
        if (gen.current !== g || activeRef.current !== sessionId) return;
        setEarlierBusy(false);
        if (!isObj(r) || !Array.isArray(r.messages) ||
            !r.messages.every((m) => validMessage(m, sessionId))) {
          /* A failed history page is never an empty conversation. */
          return setEarlierErr(MALFORMED);
        }
        setThread((cur) => {
          if (cur.kind !== "ready") return cur;
          const seen = new Set(cur.value.messages.map((m) => m.message_id));
          const fresh = r.messages.filter((m) => !seen.has(m.message_id));
          const merged = [...fresh, ...cur.value.messages].sort((a, b) => a.seq - b.seq);
          return { kind: "ready", value: { ...cur.value, messages: merged, oldestSeq: Math.min(cur.value.oldestSeq, merged[0]?.seq ?? cur.value.oldestSeq) } };
        });
      })
      .catch((e) => {
        if (gen.current !== g || activeRef.current !== sessionId) return;
        setEarlierBusy(false);
        setEarlierErr(failOf(e));
      });
  };

  /* ============================ turn submit ============================ */

  const send = () => {
    const sessionId = activeId;
    const text = body.trim();
    if (!sessionId || !text || turnFlight.current) return;
    if (thread.kind === "ready" && thread.value.session.state === "CLOSED") return;
    const g = gen.current;
    /* Idempotency: retrying the same body on the same session reuses the
       original key; a new message gets a fresh key; the key never crosses
       sessions. */
    const prev = pendingSubmit.current;
    const key = prev && prev.sessionId === sessionId && prev.body === text
      ? prev.key
      : crypto.randomUUID();
    pendingSubmit.current = { sessionId, body: text, key };
    turnFlight.current = { sessionId, g, key };
    setTurnBusy(true);
    setTurnNote(null);
    apiAdmin
      .conversationTurn(sessionId, { body: text, idempotency_key: key })
      .then((r: ConversationTurnResult) => {
        if (turnFlight.current?.key === key) { turnFlight.current = null; setTurnBusy(false); }
        /* The result may paint only on the session it was sent to. */
        if (gen.current !== g || activeRef.current !== sessionId) return;
        /* F3 — a malformed HTTP 200 is NOT a proven successful turn:
           validate the whole canonical response (operator message +
           assistant reply, session-bound, integer seqs, proposal shape)
           BEFORE clearing composer or pendingSubmit. */
        const ok =
          validMessage(r.message, sessionId) && r.message.role === "operator" &&
          validMessage(r.reply, sessionId) && r.reply.role === "assistant" &&
          (r.reused === undefined || typeof r.reused === "boolean") &&
          (r.proposal === undefined ||
            (isObj(r.proposal) && typeof r.proposal.goal === "string"));
        if (!ok) {
          /* Keep composer + pendingSubmit — the turn may still have
             committed. Canonical refetch reconciles; a deliberate retry
             replays the SAME key+body+session. Never auto-retry, never
             mint a second turn. */
          setTurnNote(
            "Turn outcome could not be verified — the response was malformed and the turn may still have committed. Canonical history was refreshed; a deliberate retry replays the same idempotency key.",
          );
          loadThread(sessionId);
          loadDrafts(sessionId);
          loadSessions();
          return;
        }
        pendingSubmit.current = null;
        setBody("");
        const prop = r.proposal;
        if (prop && isObj(prop) && typeof prop.goal === "string") {
          if (prop.draft && isObj(prop.draft)) {
            /* canonical draft materialized ��� the drafts refetch renders it */
          } else if (Array.isArray(prop.project_candidates)) {
            const cands = prop.project_candidates.filter(
              (c): c is { project_id: string; name: string } =>
                isObj(c) && typeof c.project_id === "string" && !!c.project_id,
            );
            if (cands.length !== prop.project_candidates.length || cands.length === 0) {
              setTurnNote("Proposal candidates were malformed — no project was chosen; no draft created.");
            } else {
              const msgId = String(r.message.message_id);
              /* F2 — a new proposal RESETS any previous selection and
                 obsolete validation; the pick is bound to this exact
                 proposing message and candidate set. */
              setProp({ messageId: msgId, goal: prop.goal, candidates: cands });
              setProposalPick("");
              /* Verify candidates against the canonical projects read —
                 never infer identity, never fall back to AppShell business. */
              projectsReq.current?.abort();
              const ctl = new AbortController();
              projectsReq.current = ctl;
              const gg = gen.current;
              setProposalProjects({ kind: "loading" });
              apiAdmin
                .projects(ctl.signal)
                .then((rows) => {
                  if (gen.current !== gg || activeRef.current !== sessionId) return;
                  if (proposalRef.current?.messageId !== msgId) return; // obsolete proposal
                  if (!Array.isArray(rows) || !rows.every(validProject))
                    return setProposalProjects({ kind: "error", err: MALFORMED });
                  const known = new Set(rows.map((p) => p.project_id));
                  if (!cands.every((c) => known.has(c.project_id)))
                    return setProposalProjects({
                      kind: "error",
                      err: { code: "MALFORMED", detail: "A proposal candidate is absent from the canonical project list — no choice can be made safely." },
                    });
                  setProposalProjects({ kind: "ready", value: rows });
                })
                .catch((e) => {
                  if (gen.current !== gg || activeRef.current !== sessionId) return;
                  if (ctl.signal.aborted) return;
                  if (proposalRef.current?.messageId !== msgId) return;
                  setProposalProjects({ kind: "error", err: failOf(e) });
                });
            }
          } else if (prop.rejected) {
            setTurnNote(`Proposal rejected by the canonical contract (${String(prop.rejected)}). Zero missions were created.`);
          }
        }
        /* canonical refresh after mutation */
        loadThread(sessionId);
        loadDrafts(sessionId);
        loadSessions();
      })
      .catch((e) => {
        if (turnFlight.current?.key === key) { turnFlight.current = null; setTurnBusy(false); }
        /* F1 — a late turn failure paints only on the session it was sent
           to; on another session it is silently dropped (pendingSubmit
           retains the retry identity for a revisit). */
        if (gen.current !== g || activeRef.current !== sessionId) return;
        const f = failOf(e);
        /* The POST may have committed — keep composer + pendingSubmit so a
           deliberate retry replays the SAME key+body+session. */
        setTurnNote(
          `Turn outcome is unknown (${f.code}) — the request may have committed. The composer was kept; Send again replays the same idempotency key.`,
        );
      });
  };

  /* ============================ draft ops ============================ */

  const openDraftForm = (revise?: MissionDraft) => {
    if (!activeId) return;
    const sessionId = activeId;
    setDraftForm({
      open: true,
      goal: revise?.goal ?? "",
      projectId: revise?.project_id ?? "",
      supersedes: revise?.draft_id ?? null,
      /* Prefill comes from the persisted draft's own canonical fields —
         nothing is invented. */
      permissions: revise ? revise.granted_permissions.join(", ") : "",
      workspaces: revise?.authorized_workspaces?.join(", ") ?? "",
      risk: revise?.risk_ceiling ?? "",
    });
    draftFormReq.current?.abort();
    const ctl = new AbortController();
    draftFormReq.current = ctl;
    const g = gen.current;
    setDraftFormProjects({ kind: "loading" });
    apiAdmin
      .projects(ctl.signal)
      .then((rows) => {
        if (gen.current !== g || activeRef.current !== sessionId) return;
        if (!Array.isArray(rows) || !rows.every(validProject))
          return setDraftFormProjects({ kind: "error", err: MALFORMED });
        setDraftFormProjects({ kind: "ready", value: rows });
      })
      .catch((e) => {
        if (gen.current !== g || activeRef.current !== sessionId) return;
        setDraftFormProjects({ kind: "error", err: failOf(e) });
      });
  };

  const submitDraft = () => {
    const sessionId = activeId;
    if (!sessionId || mutFlight.current) return;
    const goal = draftForm.goal.trim();
    if (!goal || !draftForm.projectId) return;
    const flights = `create-draft:${sessionId}`;
    mutFlight.current = flights;
    setMutBusy(flights);
    setMutNote(null);
    const perms = draftForm.permissions.split(",").map((s) => s.trim()).filter(Boolean);
    const wss = draftForm.workspaces.split(",").map((s) => s.trim()).filter(Boolean);
    apiAdmin
      .createDraft(sessionId, {
        project_id: draftForm.projectId,
        goal,
        ...(perms.length ? { granted_permissions: perms } : {}),
        ...(draftForm.workspaces.trim() ? { authorized_workspaces: wss } : {}),
        ...(draftForm.risk ? { risk_ceiling: draftForm.risk } : {}),
        ...(draftForm.supersedes ? { supersedes_draft_id: draftForm.supersedes } : {}),
      })
      .then((r) => {
        mutFlight.current = null;
        setMutBusy(null);
        if (activeRef.current === sessionId) {
          if (!isObj(r) || !validDraft(r.draft, sessionId)) {
            setMutNote("Draft create response was malformed — refreshing the canonical draft list.");
          } else {
            setDraftForm({ open: false, goal: "", projectId: "", supersedes: null, permissions: "", workspaces: "", risk: "" });
            setMutNote(null);
          }
          loadDrafts(sessionId);
        }
      })
      .catch((e) => {
        mutFlight.current = null;
        setMutBusy(null);
        if (activeRef.current === sessionId) {
          setMutNote(`Draft creation may not have committed (${failOf(e).code}) — no substitute draft is minted; refresh before retrying.`);
          loadDrafts(sessionId);
        }
      });
  };

  const submitProposalDraft = () => {
    const sessionId = activeId;
    if (!sessionId || mutFlight.current) return;
    /* F2 — immediately before POST, re-check: the proposing message is
       still the current one, the pick is inside ITS candidate set, and
       canonical project validation has succeeded on a verified list. */
    const prop = proposalRef.current;
    if (!prop || !proposalPick) return;
    if (!prop.candidates.some((c) => c.project_id === proposalPick)) return;
    if (proposalProjects?.kind !== "ready") return;
    if (!proposalProjects.value.some((p) => p.project_id === proposalPick)) return;
    const flights = `proposal-draft:${prop.messageId}`;
    mutFlight.current = flights;
    setMutBusy(flights);
    setMutNote(null);
    apiAdmin
      .createDraft(sessionId, {
        project_id: proposalPick,
        goal: prop.goal,
        /* Mirrors the server's own auto-mint: permissions/workspaces/risk
           are left to canonical defaults — none are invented here. */
        client_request_id: `proposal:${prop.messageId}`,
      })
      .then((r) => {
        mutFlight.current = null;
        setMutBusy(null);
        if (activeRef.current === sessionId) {
          if (!isObj(r) || !validDraft(r.draft, sessionId)) {
            setMutNote("Proposal draft response was malformed — refreshing the canonical draft list.");
          } else {
            setProp(null);
            setProposalPick("");
          }
          loadDrafts(sessionId);
        }
      })
      .catch((e) => {
        mutFlight.current = null;
        setMutBusy(null);
        if (activeRef.current === sessionId) {
          setMutNote(`Proposal draft creation may not have committed (${failOf(e).code}) — refresh before retrying; no substitute draft is minted.`);
          loadDrafts(sessionId);
        }
      });
  };

  /* Confirm/reject: the dialog pins session_id + draft_id + digest at open
     time; the POST always targets those pinned ids even if the operator
     switched sessions mid-flight. The result only paints when the pinned
     session is still the active one — it is never applied to another. */
  const runDialog = () => {
    if (!dialog || mutFlight.current) return;
    const d = dialog;
    if (d.op === "confirm") {
      const flights = `confirm:${d.sessionId}:${d.draft.draft_id}`;
      mutFlight.current = flights;
      setMutBusy(flights);
      setMutNote(null);
      apiAdmin
        .confirmDraft(d.sessionId, d.draft.draft_id, d.draft.draft_digest)
        .then((r) => {
          mutFlight.current = null;
          setMutBusy(null);
          setDialog(null);
          if (activeRef.current === d.sessionId) {
            if (isObj(r) && typeof r.mission_id === "string" && r.mission_id) {
              setConfirmedMission({ sessionId: d.sessionId, missionId: r.mission_id });
            } else {
              setMutNote("Draft confirmed but no canonical mission_id was returned — the mission list is authoritative.");
            }
            loadDrafts(d.sessionId);
            loadThread(d.sessionId);
          }
          loadSessions();
        })
        .catch((e) => {
          mutFlight.current = null;
          setMutBusy(null);
          setDialog(null);
          /* F1 — an A-specific failure note never paints into session B. */
          if (activeRef.current === d.sessionId) {
            /* Possibly committed — honest ambiguous notice + refresh offer. */
            setMutNote(
              `Confirmation outcome is unknown (${failOf(e).code}) — the POST may have committed. No auto-retry was attempted; refresh the draft list to inspect canonical state before any deliberate retry.`,
            );
            loadDrafts(d.sessionId);
          }
          loadSessions();
        });
      return;
    }
    if (d.op === "reject") {
      const flights = `reject:${d.sessionId}:${d.draft.draft_id}`;
      mutFlight.current = flights;
      setMutBusy(flights);
      setMutNote(null);
      apiAdmin
        .rejectDraft(d.sessionId, d.draft.draft_id)
        .then(() => {
          mutFlight.current = null;
          setMutBusy(null);
          setDialog(null);
          if (activeRef.current === d.sessionId) loadDrafts(d.sessionId);
        })
        .catch((e) => {
          mutFlight.current = null;
          setMutBusy(null);
          setDialog(null);
          if (activeRef.current === d.sessionId) {
            setMutNote(`Rejection outcome is unknown (${failOf(e).code}) — the POST may have committed. No auto-retry was attempted; refresh canonical state first.`);
            loadDrafts(d.sessionId);
          }
        });
      return;
    }
    /* close */
    const flights = `close:${d.sessionId}`;
    mutFlight.current = flights;
    setMutBusy(flights);
    setMutNote(null);
    apiAdmin
      .closeConversation(d.sessionId)
      .then(() => {
        mutFlight.current = null;
        setMutBusy(null);
        setDialog(null);
        loadSessions();
        if (activeRef.current === d.sessionId) {
          loadThread(d.sessionId);
          loadDrafts(d.sessionId);
        }
      })
      .catch((e) => {
        mutFlight.current = null;
        setMutBusy(null);
        setDialog(null);
        if (activeRef.current === d.sessionId) {
          setMutNote(`Close may not have committed (${failOf(e).code}) — refresh canonical state before retrying.`);
        }
        loadSessions();
      });
  };

  /* ============================ render ============================ */

  const session = thread.kind === "ready" ? thread.value.session : null;
  const closed = session?.state === "CLOSED";

  const dialogBody = () => {
    if (!dialog) return { title: "", body: "", confirmLabel: "Confirm", confirmDisabled: false };
    if (dialog.op === "close") {
      return {
        title: "Close conversation?",
        body: `This posts to the canonical close endpoint for session ${dialog.sessionId}. The conversation becomes read-only; drafts already minted keep their own lifecycle. There is no undo inside this UI.`,
        confirmLabel: "Close conversation",
        confirmDisabled: false,
      };
    }
    const dr = dialog.draft;
    const expired = draftExpired(dr);
    if (dialog.op === "confirm") {
      return {
        title: "Confirm mission draft?",
        body:
          `This is the ONLY execution authority in chat — it posts the pinned expected_digest to the canonical confirm endpoint and may launch a governed mission.\n\n` +
          `session: ${dialog.sessionId}\ndraft: ${dr.draft_id}\ndigest: ${dr.draft_digest}\nproject: ${dr.project_id}\ngoal: ${dr.goal}\n` +
          `permissions: ${dr.granted_permissions.join(", ") || "(none)"}\n` +
          `workspaces: ${dr.authorized_workspaces?.join(", ") || "(inherit project root)"}\n` +
          `risk ceiling: ${dr.risk_ceiling ?? "(canonical default HIGH)"}\nexpires_at: ${dr.expires_at ?? "—"}` +
          (expired ? `\n\nThis draft is past its expires_at — confirmation is disabled.` : ""),
        confirmLabel: "Confirm draft",
        confirmDisabled: dr.state !== "PENDING_CONFIRMATION" || expired,
      };
    }
    return {
      title: "Reject mission draft?",
      body:
        `This rejects the pinned draft via the canonical endpoint — it never mutates any other draft.\n\n` +
        `session: ${dialog.sessionId}\ndraft: ${dr.draft_id}\ndigest: ${dr.draft_digest}\ngoal: ${dr.goal}`,
      confirmLabel: "Reject draft",
      confirmDisabled: false,
    };
  };
  const dlg = dialogBody();

  return (
    <div className="page chat2">
      <h1>Chat</h1>
      <p className="note">
        Conversation layer — a turn may mint a draft, but text is never execution authority.
        A mission runs only through the pinned-draft confirmation contract below.
      </p>

      <div className="chatgrid">
        {/* ============ sessions sidebar ============ */}
        <aside className="chatside">
          <div className="ofrow" style={{ marginBottom: 8 }}>
            <label htmlFor="newconv">New conversation</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                id="newconv"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="title (optional)"
                disabled={mutBusy === "new-session"}
              />
              <button
                className="tbtn"
                onClick={createSession}
                disabled={mutBusy === "new-session"}
              >
                {mutBusy === "new-session" ? "…" : "Create"}
              </button>
            </div>
          </div>
          <div className="sech">Conversations</div>
          {sessions.kind === "loading" ? (
            <><Skeleton height={14} /><Skeleton height={14} /><Skeleton height={14} /></>
          ) : sessions.kind === "error" ? (
            <ErrorState code={sessions.err.code} detail={sessions.err.detail} onRetry={loadSessions} />
          ) : sessions.value.length === 0 ? (
            <EmptyState title="No conversations" detail="The canonical list returned zero sessions." />
          ) : (
            <ul className="chatlist" role="list">
              {sessions.value.map((s) => (
                <li key={s.session_id}>
                  <button
                    className={`chatitem${s.session_id === activeId ? " on" : ""}`}
                    onClick={() => pickSession(s.session_id)}
                    aria-current={s.session_id === activeId}
                  >
                    <span className="tt trunc">{s.title || s.session_id}</span>
                    <span className="meta mono">
                      {s.state}
                      {typeof s.message_count === "number" ? ` · ${s.message_count} msgs` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* ============ main column ============ */}
        <section className="chatmain">
          {!activeId ? (
            <EmptyState title="Select a conversation" detail="Choose a session on the left or create a new one. Deep links via ?s=<session_id> are supported." />
          ) : (
            <>
              {/* ---- session header ---- */}
              <div className="chathead">
                {thread.kind === "loading" ? (
                  <Skeleton height={16} width="55%" />
                ) : thread.kind === "error" ? (
                  <ErrorState code={thread.err.code} detail={thread.err.detail} onRetry={() => loadThread(activeId)} />
                ) : (
                  <>
                    <div className="chathead-main">
                      <strong>{thread.value.session.title || thread.value.session.session_id}</strong>
                      <StatusBadge tone={thread.value.session.state === "OPEN" ? "ok" : "danger"} label={thread.value.session.state} />
                      <span className="note mono">{thread.value.session.message_count ?? "?"} msgs</span>
                    </div>
                    <div className="chathead-meta note mono">
                      id {thread.value.session.session_id} · owner {thread.value.session.owner_operator_id}
                      {thread.value.session.closed_at ? ` · closed ${thread.value.session.closed_at}` : ""}
                    </div>
                    {thread.value.session.state === "OPEN" ? (
                      <button
                        className="tbtn danger"
                        onClick={() => setDialog({ op: "close", sessionId: activeId, title: thread.value.session.title ?? undefined })}
                        disabled={mutBusy !== null}
                      >
                        Close conversation
                      </button>
                    ) : null}
                  </>
                )}
              </div>

              {/* ---- thread ---- */}
              {thread.kind === "ready" && (
                <div className="chatthread" role="log" aria-label="Conversation thread">
                  {thread.value.oldestSeq > 1 ? (
                    <div className="chatloadmore">
                      <button className="tbtn" onClick={loadEarlier} disabled={earlierBusy}>
                        {earlierBusy ? "Loading…" : `Load earlier (seq < ${thread.value.oldestSeq})`}
                      </button>
                      {earlierErr ? (
                        <span className="warn"> history load failed ({earlierErr.code}) — earlier messages exist but were not shown</span>
                      ) : null}
                    </div>
                  ) : null}
                  {thread.value.messages.length === 0 ? (
                    <EmptyState title="Empty conversation" detail="The canonical message log holds zero entries for this tail window." />
                  ) : (
                    thread.value.messages.map((m) => (
                      <div key={m.message_id} className={`chatmsg ${m.role}`}>
                        <div className="chatmsg-h">
                          <span className={`chatrole ${m.role}`}>{m.role}</span>
                          <span className="mono note">seq {m.seq}</span>
                          <span className="mono note">{m.created_at}</span>
                        </div>
                        <div className="chatmsg-b">{m.body}</div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {turnNote ? <div className="warn note" role="status">{turnNote}</div> : null}
              {mutNote ? <div className="warn note" role="status">{mutNote}</div> : null}
              {confirmedMission && confirmedMission.sessionId === activeId ? (
                <div className="note" role="status">
                  Draft confirmed — canonical mission:{" "}
                  <Link className="lnk" to={`/app/missions/${confirmedMission.missionId}`}>
                    {confirmedMission.missionId}
                  </Link>
                </div>
              ) : null}

              {/* ---- proposal picker ---- */}
              {proposal ? (
                <div className="chatprop" role="region" aria-label="Mission proposal">
                  <div className="sech" style={{ marginTop: 0 }}>Proposal — choose a project</div>
                  <div className="note">
                    The assistant proposed a mission but the project was ambiguous server-side.
                    An explicit selection is required; every candidate was re-validated against
                    the canonical project list. No draft exists until you choose.
                  </div>
                  <div className="dmeta">
                    <dt>goal</dt>
                    <dd>{proposal.goal}</dd>
                    <dt>message</dt>
                    <dd className="mono">{proposal.messageId}</dd>
                    <dt>request binding</dt>
                    <dd className="mono">client_request_id: proposal:{proposal.messageId}</dd>
                  </div>
                  {proposalProjects?.kind === "loading" ? (
                    <Skeleton height={14} width="40%" />
                  ) : proposalProjects?.kind === "error" ? (
                    <ErrorState
                      code={proposalProjects.err.code}
                      detail={`${proposalProjects.err.detail} — project choice is blocked; no fallback is allowed.`}
                    />
                  ) : proposalProjects?.kind === "ready" ? (
                    <div className="ofrow">
                      <label htmlFor="projsel">Project</label>
                      <select id="projsel" value={proposalPick} onChange={(e) => setProposalPick(e.target.value)}>
                        <option value="">— choose —</option>
                        {proposal.candidates.map((c) => (
                          <option key={c.project_id} value={c.project_id}>
                            {c.name ? `${c.name} (${c.project_id})` : c.project_id}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  <div className="actbar">
                    <button
                      className="tbtn"
                      disabled={!proposalPick || mutBusy !== null || proposalProjects?.kind !== "ready"}
                      onClick={submitProposalDraft}
                    >
                      {mutBusy?.startsWith("proposal-draft:") ? "Creating…" : "Create draft (pending confirmation)"}
                    </button>
                    <button
                      className="tbtn"
                      onClick={() => { setProp(null); setProposalPick(""); }}
                      disabled={mutBusy !== null}
                    >
                      Dismiss — create no draft
                    </button>
                  </div>
                </div>
              ) : null}

              {/* ---- drafts ---- */}
              <div className="sech">Mission drafts</div>
              {draftsSec.kind === "loading" ? (
                <><Skeleton height={14} /><Skeleton height={60} /></>
              ) : draftsSec.kind === "error" ? (
                <ErrorState code={draftsSec.err.code} detail={draftsSec.err.detail} onRetry={() => loadDrafts(activeId)} />
              ) : draftsSec.value.length === 0 ? (
                <EmptyState title="No drafts" detail="Zero drafts are persisted for this session — nothing is confirmable." />
              ) : (
                draftsSec.value.map((d) => (
                  <div key={d.draft_id} className="draftcard">
                    <div className="draftcard-h">
                      <StatusBadge
                        tone={draftTone(d)}
                        label={d.state === "PENDING_CONFIRMATION" && draftExpired(d) ? "EXPIRED (wall-clock)" : d.state}
                      />
                      <span className="mono note">{d.draft_id}</span>
                      {d.state === "CONFIRMED" && d.mission_id ? (
                        <Link className="lnk" to={`/app/missions/${d.mission_id}`}>mission {d.mission_id}</Link>
                      ) : null}
                    </div>
                    <DraftTerms d={d} />
                    <div className="actbar">
                      {d.state === "PENDING_CONFIRMATION" ? (
                        <>
                          <button
                            className="tbtn"
                            disabled={!draftConfirmable(d) || mutBusy !== null}
                            title={draftExpired(d) ? "Past expires_at — never offered as confirmable" : "Confirm via pinned digest"}
                            onClick={() => setDialog({ op: "confirm", sessionId: activeId, draft: d })}
                          >
                            Confirm…
                          </button>
                          <button
                            className="tbtn danger"
                            disabled={mutBusy !== null}
                            onClick={() => setDialog({ op: "reject", sessionId: activeId, draft: d })}
                          >
                            Reject…
                          </button>
                          <button
                            className="tbtn"
                            disabled={mutBusy !== null}
                            onClick={() => openDraftForm(d)}
                          >
                            Revise (new draft supersedes)
                          </button>
                        </>
                      ) : (
                        <span className="note">
                          {d.state === "SUBMITTING"
                            ? "SUBMITTING — submission in progress on the backend; not assumed done."
                            : d.state === "CONFIRMED"
                              ? "Confirmed — see mission link above."
                              : `${d.state} — terminal state; never offered as confirmable.`}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}

              {/* ---- draft form ---- */}
              {draftForm.open ? (
                <div className="chatprop" role="region" aria-label="New mission draft">
                  <div className="sech" style={{ marginTop: 0 }}>
                    {draftForm.supersedes ? `Revise draft ${draftForm.supersedes}` : "New mission draft"}
                  </div>
                  <div className="note">
                    Creates a new PENDING draft — never mutates an existing one. Blank fields
                    inherit canonical defaults (no permissions, project-root workspaces, risk HIGH).
                    Values you type are sent verbatim.
                  </div>
                  {draftFormProjects?.kind === "loading" ? (
                    <Skeleton height={14} width="40%" />
                  ) : draftFormProjects?.kind === "error" ? (
                    <ErrorState code={draftFormProjects.err.code} detail={`${draftFormProjects.err.detail} — draft creation is blocked without a verified project list.`} />
                  ) : draftFormProjects?.kind === "ready" ? (
                    <>
                      <div className="ofrow">
                        <label htmlFor="df-proj">Project</label>
                        <select id="df-proj" value={draftForm.projectId} onChange={(e) => setDraftForm({ ...draftForm, projectId: e.target.value })}>
                          <option value="">— choose —</option>
                          {draftFormProjects.value.map((p) => (
                            <option key={p.project_id} value={p.project_id}>
                              {p.name ? `${p.name} (${p.project_id})` : p.project_id}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="ofrow">
                        <label htmlFor="df-goal">Goal</label>
                        <textarea id="df-goal" rows={3} value={draftForm.goal} onChange={(e) => setDraftForm({ ...draftForm, goal: e.target.value })} />
                      </div>
                      <div className="ofrow2">
                        <div className="ofrow">
                          <label htmlFor="df-perms">Permissions (comma-separated, explicit)</label>
                          <input id="df-perms" value={draftForm.permissions} onChange={(e) => setDraftForm({ ...draftForm, permissions: e.target.value })} placeholder="blank = none granted" />
                        </div>
                        <div className="ofrow">
                          <label htmlFor="df-ws">Workspaces (comma-separated, explicit)</label>
                          <input id="df-ws" value={draftForm.workspaces} onChange={(e) => setDraftForm({ ...draftForm, workspaces: e.target.value })} placeholder="blank = inherit project root" />
                        </div>
                      </div>
                      <div className="ofrow">
                        <label htmlFor="df-risk">Risk ceiling</label>
                        <select id="df-risk" value={draftForm.risk} onChange={(e) => setDraftForm({ ...draftForm, risk: e.target.value })}>
                          <option value="">— canonical default (HIGH) —</option>
                          {RISK_LEVELS.map((r) => (<option key={r} value={r}>{r}</option>))}
                        </select>
                      </div>
                      <div className="actbar">
                        <button
                          className="tbtn"
                          disabled={!draftForm.projectId || !draftForm.goal.trim() || mutBusy !== null}
                          onClick={submitDraft}
                        >
                          {mutBusy?.startsWith("create-draft:") ? "Creating…" : "Create draft"}
                        </button>
                        <button className="tbtn" onClick={() => setDraftForm({ ...draftForm, open: false })} disabled={mutBusy !== null}>
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}

              {/* ---- composer ---- */}
              <div className="chatcomposer">
                {closed ? (
                  <div className="note">Conversation is CLOSED — the composer is disabled; no turns can be sent.</div>
                ) : (
                  <>
                    <textarea
                      rows={3}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      placeholder={activeId ? "Message — Enter sends a turn; Ctrl/Cmd+Enter also works" : "Select a conversation first"}
                      disabled={!activeId || turnBusy}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          send();
                        }
                      }}
                    />
                    <div className="actbar">
                      <button
                        className="tbtn"
                        onClick={send}
                        disabled={!activeId || !body.trim() || turnBusy}
                      >
                        {turnBusy ? "Sending…" : "Send"}
                      </button>
                      <button
                        className="tbtn"
                        onClick={() => openDraftForm()}
                        disabled={!activeId || mutBusy !== null || closed}
                      >
                        + New draft
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={dialog !== null}
        title={dlg.title}
        body={dlg.body}
        confirmLabel={dlg.confirmLabel}
        busy={mutBusy !== null}
        confirmDisabled={dlg.confirmDisabled}
        onConfirm={runDialog}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
