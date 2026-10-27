import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, apiAdmin, getOperatorId } from "../../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Skeleton } from "../components/states";
import { StatusBadge } from "../components/StatusBadge";
import { DagView } from "../../components/Dag";
import type { Dag, MissionPreview, ProjectRow } from "../types";

/* P15.9-B5.3 — Task Entry: project → goal → preview → pinned confirm.
   Default is human-reviewed confirm; auto-confirm is an explicit opt-in.
   ONE confirmation seam: POST /api/missions/confirm {preview_id,
   plan_digest} — never both endpoints, never re-plan. */

type St =
  | { kind: "loading" }
  | { kind: "ready"; projects: ProjectRow[] }
  | { kind: "unavailable"; code: string }
  | { kind: "error"; err: ApiError };

type CoverageRow = {
  requirement_id: string;
  kind: string;
  state: string;
  task_keys: string[];
};

type Pinned = {
  preview_id: string;
  plan_digest: string;
  tasks: Array<Record<string, unknown>>;
  source: string | null;
  model: string | null;
  /* Semantic Planning V1 (G′) — deterministic coverage report the
     winning plan proved; read-only review evidence, never authority. */
  coverage_report: { verdict: string; rows: CoverageRow[] } | null;
  /* P18.6 — pinned semantic goal-interpretation evidence (advisory
     read model: what PAIR understood — never authority). */
  goal_interpretation: {
    analysis_digest: string | null;
    ambiguity_class: string | null;
    status: string | null;
    unavailable_reason: string | null;
    mode: string | null;
    items: Array<{
      id: string | null; category: string | null;
      statement: string | null; authority: string | null;
      confidence: string | null; source_span: string | null;
      alternatives?: string[];
    }>;
  } | null;
  /* effective inputs pinned at preview time — any change invalidates */
  project_id: string;
  goal: string;
};

function taskRows(tasks: Array<Record<string, unknown>>) {
  /* R2-C strict preview task structure (canonical planner contract):
     every task needs a nonempty task_key plus required_capabilities and
     depends_on as arrays of strings. Missing/null fields are never
     silently coerced to empty arrays — the whole preview is INVALID.
     Genuine empty arrays remain valid (the planner emits [] deps). */
  return tasks.every((t) => {
    if (t === null || typeof t !== "object") return false;
    if (typeof t.task_key !== "string" || t.task_key.trim() === "") return false;
    if (!Array.isArray(t.required_capabilities)
      || !t.required_capabilities.every((c) => typeof c === "string")) return false;
    if (!Array.isArray(t.depends_on)
      || !t.depends_on.every((d) => typeof d === "string")) return false;
    return true;
  });
}

export function MissionNew() {
  const nav = useNavigate();
  const [st, setSt] = useState<St>({ kind: "loading" });
  /* UI-V2 — ?goal= prefill from the NL intake handoff (Mission kind).
     Preview/confirm/digest checks are unchanged. */
  const [searchParams] = useSearchParams();
  const [goal, setGoal] = useState(() => searchParams.get("goal") ?? "");
  const [projectId, setProjectId] = useState("");
  const [preview, setPreview] = useState<Pinned | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  /* P18.6 — owner-approval selection over advisory interpretation items */
  const [intentSel, setIntentSel] = useState<Record<string, boolean>>({});
  const [intentBusy, setIntentBusy] = useState(false);
  const [mutNote, setMutNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [autoConfirm, setAutoConfirm] = useState(false); /* opt-in, default OFF */
  const seq = useRef(0);
  /* R1-F2: refs mirror live state so async continuations compare against
     CURRENT inputs — a stale render closure can never validate a stale pin. */
  const inputsRef = useRef({ projectId: "", goal: "", auto: false });
  inputsRef.current = { projectId, goal, auto: autoConfirm };
  /* R3-F1: the ACTIVE preview request owns previewBusy — obsolete requests
     are aborted on invalidation and can never render, commit, or clear a
     newer request's busy state. Confirmation is deliberately separate: a
     potentially committed POST is never aborted or silently forgotten. */
  const previewReq = useRef<{ id: number; ctl: AbortController } | null>(null);
  const confirmFlight = useRef(false); /* confirm single-flight */

  useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        const v = await apiAdmin.projects(ctl.signal);
        if (ctl.signal.aborted) return;
        /* raw array + element validation — malformed blocks Task Entry */
        if (!Array.isArray(v) || !v.every((p) => p !== null && typeof p === "object" && p.project_id != null)) {
          setSt({ kind: "unavailable", code: "MALFORMED" });
          return;
        }
        setSt({ kind: "ready", projects: v });
      } catch (e) {
        if (ctl.signal.aborted) return;
        setSt(e instanceof ApiError && e.status === 401
          ? { kind: "error", err: e }
          : { kind: "unavailable", code: e instanceof ApiError ? e.code : "ERROR" });
      }
    })();
    return () => ctl.abort();
  }, []);

  const project = useMemo(
    () => (st.kind === "ready" ? st.projects.find((p) => String(p.project_id) === projectId) : undefined),
    [st, projectId],
  );
  const inputsValid = st.kind === "ready" && goal.trim().length > 0 && projectId.length > 0 && project !== undefined;

  /* R1-F2: bump the generation so any in-flight preview belonging to
     previous inputs is ignored when it lands.
     R2-A: if inputs change while a confirmation POST is in flight, the
     outcome is honestly unknown — the mission may have been committed.
     Surface that instead of silently dropping the result (which would
     invite an unsafe duplicate submission). No automatic retries. */
  const invalidate = () => {
    seq.current++;
    /* R3-F1: cancel the obsolete preview fetch and release its UI lock
       immediately — a fresh preview may start while A is unresolved. */
    previewReq.current?.ctl.abort();
    previewReq.current = null;
    setPreviewBusy(false);
    setPreview(null);
    setConfirming(false);
    setIntentSel({});
    if (confirmFlight.current) {
      setMutNote("Inputs changed while a confirmation was in flight — outcome unknown; the mission may have been committed. Check Mission Operations before resubmitting. No automatic retry.");
    }
  };

  const payload = () => ({
    project_id: projectId,
    goal: goal.trim(),
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: project ? [String(project.root_location ?? "")].filter(Boolean) : [],
  });

  /* persisted-preview validation + pinned construction — shared by the
     normal preview edge AND the P18.6 amended-revision re-preview so a
     malformed response is INVALID identically on both paths. */
  const pinnedFrom = (r: MissionPreview | null | undefined): Pinned | null => {
    if (!r || typeof r !== "object" || !r.preview_id || !r.plan_digest
      || !r.plan || !Array.isArray(r.plan.tasks) || r.plan.tasks.length === 0
      || !taskRows(r.plan.tasks)) return null;
    const cov = (r as { coverage_report?: unknown }).coverage_report;
    const gi = (r as { goal_interpretation?: unknown }).goal_interpretation;
    return {
      preview_id: String(r.preview_id),
      plan_digest: String(r.plan_digest),
      tasks: r.plan.tasks,
      source: r.plan_source ?? null,
      model: r.plan_model ?? null,
      coverage_report:
        cov &&
        typeof cov === "object" &&
        (cov as { verdict?: unknown }).verdict === "PASS" &&
        Array.isArray((cov as { rows?: unknown }).rows)
          ? (cov as Pinned["coverage_report"])
          : null,
      goal_interpretation:
        gi &&
        typeof gi === "object" &&
        Array.isArray((gi as { items?: unknown }).items)
          ? (gi as Pinned["goal_interpretation"])
          : null,
      project_id: projectId,
      goal: goal.trim(),
    };
  };

  /* P18.6 — approve selected advisory interpretation items → the server
     mints a digest-bound amended goal revision → re-preview that exact
     revision. The original operator request stays immutable; approval
     binds the pinned analysis + preview + operator + scope. */
  const APPROVABLE = new Set(["MODEL_INFERRED", "PROPOSED_AMENDMENT", "UNRESOLVED"]);
  const doApproveIntent = async () => {
    if (!preview || intentBusy || confirmFlight.current) return;
    const ids = Object.keys(intentSel).filter((k) => intentSel[k]);
    if (!ids.length) return;
    previewReq.current?.ctl.abort();
    const ctl = new AbortController();
    const s = ++seq.current;
    const mine = { id: s, ctl };
    previewReq.current = mine;
    const pinnedInputs = { project_id: preview.project_id, goal: preview.goal };
    setIntentBusy(true);
    setPreviewErr(null);
    setMutNote(null);
    try {
      const ap = await apiAdmin.approveGoalIntent({ preview_id: preview.preview_id, item_ids: ids });
      const r: MissionPreview = await apiAdmin.previewMission(
        { ...payload(), goal_intent_approval_id: ap.approval_id },
        ctl.signal,
      );
      if (s !== seq.current) return;
      if (pinnedInputs.project_id !== inputsRef.current.projectId
        || pinnedInputs.goal !== inputsRef.current.goal.trim()) return;
      const pinned = pinnedFrom(r);
      if (!pinned) {
        setPreview(null);
        setPreviewErr("INVALID_PREVIEW — amended revision preview failed validation.");
        return;
      }
      setIntentSel({});
      setMutNote(`Owner-approved ${ids.length} interpretation${ids.length > 1 ? "s" : ""} — new governed revision previewed (approval ${String(ap.approval_id).slice(0, 14)}…).`);
      setPreview(pinned);
    } catch (e) {
      if (s !== seq.current) return;
      setPreviewErr(e instanceof ApiError ? `${e.detail || e.message} (${e.code})` : String(e));
    } finally {
      if (previewReq.current === mine) {
        previewReq.current = null;
        setIntentBusy(false);
      }
    }
  };

  const doPreview = async () => {
    if (!inputsValid || previewBusy || confirmFlight.current) return;
    if (!getOperatorId()) {
      setMutNote("operator id required — set one in the legacy header before preview/submit.");
      return;
    }
    /* R3-F1: cancel any obsolete preview still in flight, then own the
       preview slot — its id identifies the one request allowed to apply. */
    previewReq.current?.ctl.abort();
    const ctl = new AbortController();
    const s = ++seq.current;
    const mine = { id: s, ctl };
    previewReq.current = mine;
    /* R1-F2: pin the exact request inputs — a late response is applied
       only if they still match the current effective inputs. */
    const pinnedInputs = { project_id: projectId, goal: goal.trim() };
    const wasAuto = autoConfirm;
    setPreviewBusy(true);
    setPreviewErr(null);
    setMutNote(null);
    try {
      const r: MissionPreview = await apiAdmin.previewMission(payload(), ctl.signal);
      if (s !== seq.current) return;
      if (pinnedInputs.project_id !== inputsRef.current.projectId
        || pinnedInputs.goal !== inputsRef.current.goal.trim()) return;
      /* persisted-preview validation via the shared seam — invalid
         responses are never rendered as a valid empty plan */
      const pinned = pinnedFrom(r);
      if (!pinned) {
        setPreview(null);
        setPreviewErr("INVALID_PREVIEW — response missing preview_id, plan_digest or a valid task list. Nothing to confirm.");
        return;
      }
      /* auto-confirm toggled OFF while the request was in flight → the
         late response renders as a normal manual preview, never commits */
      if (wasAuto && inputsRef.current.auto) {
        await commit(pinned);
        return;
      }
      setPreview(pinned);
    } catch (e) {
      if (s !== seq.current) return;
      setPreview(null);
      setPreviewErr(e instanceof ApiError ? `${e.detail || e.message} (${e.code})` : String(e));
    } finally {
      /* R3-F1: only the request still owning the slot may clear it — an
         aborted/obsolete request never touches a newer request's state */
      if (previewReq.current === mine) {
        previewReq.current = null;
        setPreviewBusy(false);
      }
    }
  };

  const commit = async (p: Pinned) => {
    /* R1-F2/F3: re-verify the pinned inputs still match before the POST —
       a stale pin must never execute an outdated mission. */
    if (p.project_id !== inputsRef.current.projectId || p.goal !== inputsRef.current.goal.trim()) {
      setMutNote("Preview is stale — inputs changed. Request a fresh preview.");
      setPreview(null);
      setConfirming(false);
      return;
    }
    if (confirmFlight.current) return; /* R2-A: single-flight — no duplicate POST */
    confirmFlight.current = true;
    const s = ++seq.current;
    setConfirmBusy(true);
    setMutNote(null);
    try {
      const m = await apiAdmin.confirmMission({ preview_id: p.preview_id, plan_digest: p.plan_digest });
      if (s !== seq.current) return;
      const mission = (m.mission ?? m) as Record<string, unknown>;
      const mid = String(mission.mission_id ?? "");
      if (!mid) {
        setMutNote("Confirmation returned no mission_id — check Mission Operations before retrying. No automatic retry.");
        setConfirming(false);
        return;
      }
      nav(`/app/missions/${encodeURIComponent(mid)}`);
    } catch (e) {
      if (s !== seq.current) return;
      setConfirming(false);
      if (e instanceof ApiError) {
        setMutNote(
          e.status === 0 || e.status >= 500
            ? "Submission outcome unknown — the mission may have been committed. Check canonical state before retrying."
            : `Confirm failed: ${e.detail || e.message} (${e.code}) — preview not consumed by this error; request a fresh preview if it was invalidated.`,
        );
      } else {
        setMutNote("Submission outcome unknown — the mission may have been committed. Check canonical state before retrying.");
      }
    } finally {
      confirmFlight.current = false;
      setConfirmBusy(false);
    }
  };

  if (st.kind === "loading") {
    return <div className="page"><h1>Task Entry</h1><Skeleton height={18} /><Skeleton height={160} /></div>;
  }
  if (st.kind === "error") {
    return <div className="page"><h1>Task Entry</h1><StatusBadge tone="danger" label="ERROR" /><span className="note">{st.err.detail || st.err.code}</span></div>;
  }

  return (
    <div className="page narrow">
      <h1>Task Entry</h1>
      <p className="sub">
        Direct governed mission submission — no chat, no conversational draft.
        Preview persists a pinned plan; confirm consumes exactly that preview via
        one canonical seam (<code>POST /api/missions/confirm</code>). The server enforces
        the digest check — confirm never re-plans.
      </p>

      {st.kind === "unavailable" ? (
        <div className="need"><div className="nrow">
          <StatusBadge tone="warn" label="UNAVAILABLE" />
          <span className="note">project list unavailable ({st.code}) — Task Entry is blocked fail-closed: a project_id cannot be verified, never guessed.</span>
        </div></div>
      ) : (
        <div className="need">
          <div className="nrow">
            <span className="tt">Goal*</span>
            <textarea className="inp" rows={4} aria-label="goal" value={goal}
              onChange={(e) => { setGoal(e.target.value); invalidate(); }} />
          </div>
          <div className="nrow">
            <span className="tt">Project*</span>
            <select className="inp" aria-label="project" value={projectId}
              onChange={(e) => { setProjectId(e.target.value); invalidate(); }}>
              <option value="">— pick a project (verified via GET /api/projects) —</option>
              {st.projects.map((p) => (
                <option key={String(p.project_id)} value={String(p.project_id)}>
                  {String(p.name ?? p.project_id)}{p.root_location ? ` (${String(p.root_location)})` : ""}
                </option>
              ))}
            </select>
            {projectId && !project ? <span className="note">project not in verified list — blocked.</span> : null}
          </div>
          <div className="nrow" style={{ gap: 6 }}>
            <input type="checkbox" id="autoc" checked={autoConfirm}
              onChange={(e) => setAutoConfirm(e.target.checked)} />
            <label htmlFor="autoc" className="note">
              auto-confirm (opt-in) — executes immediately on successful preview via the same pinned confirm seam. Default is OFF: review first.
            </label>
          </div>
        </div>
      )}

      {mutNote ? <div className="trunc" role="status">{mutNote}</div> : null}
      {previewErr ? <div className="need"><div className="nrow"><StatusBadge tone="danger" label="ERROR" /><span className="note">{previewErr}</span></div></div> : null}

      {st.kind === "ready" && !preview ? (
        <div className="actbar">
          <button className="tbtn" disabled={previewBusy || confirmBusy || !inputsValid} onClick={doPreview}>
            {previewBusy ? "Planning…" : autoConfirm ? "Preview & execute" : "Preview plan"}
          </button>
          <span className="note">preview only — no mission is created until you confirm.</span>
        </div>
      ) : null}

      {preview ? (
        <>
          <h2 className="sech">
            Proposed plan — review before it runs{" "}
            {preview.source ? (
              <StatusBadge tone={preview.source === "LLM" ? "ok" : "warn"}
                label={preview.source === "LLM" ? `LLM plan${preview.model ? ` · ${preview.model}` : ""}` : `source: ${preview.source}`} />
            ) : <StatusBadge tone="unknown" label="source: unreported" />}
          </h2>
          <div className="need">
            <div className="nrow"><span className="note mono">preview {preview.preview_id} · digest {preview.plan_digest.slice(0, 24)}…</span></div>
            {preview.tasks.map((t) => (
              <div className="nrow" key={String(t.task_key)}>
                <code className="mono">{String(t.task_key)}</code>
                <span className="tt">{String(t.title ?? "")}</span>
                <span className="note" style={{ flex: 1 }}>{String(t.task_instruction ?? "")}</span>
                <span className="note mono">{Array.isArray(t.required_capabilities) ? t.required_capabilities.join(",") : ""}</span>
                <span className="note mono">deps: {Array.isArray(t.depends_on) && t.depends_on.length ? t.depends_on.join(",") : "—"}</span>
              </div>
            ))}
          </div>
          {preview.coverage_report ? (
            <div className="need">
              <div className="nrow">
                <span className="note mono">
                  requirement coverage — deterministic check on the pinned plan (advisory evidence)
                </span>
              </div>
              {preview.coverage_report.rows.map((r) => (
                <div className="nrow" key={r.requirement_id}>
                  <code className="mono">{r.requirement_id}</code>
                  <span className="note mono">{r.kind}</span>
                  <StatusBadge
                    tone={r.state === "PROVEN" ? "ok" : r.state === "PRESERVED" ? "warn" : "unknown"}
                    label={r.state}
                  />
                  <span className="note mono" style={{ flex: 1 }}>
                    {r.task_keys.length ? `by ${r.task_keys.join(", ")}` : "—"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {preview.goal_interpretation ? (
            <div className="need">
              <div className="nrow">
                <span className="note mono">
                  PairNext understood your goal — advisory interpretation evidence, never authority
                  {preview.goal_interpretation.ambiguity_class
                    ? ` · ambiguity: ${preview.goal_interpretation.ambiguity_class}`
                    : ""}
                  {preview.goal_interpretation.status === "unavailable"
                    ? ` · unavailable: ${preview.goal_interpretation.unavailable_reason ?? "unknown"}`
                    : ""}
                </span>
              </div>
              {preview.goal_interpretation.items.map((i) => {
                const iid = String(i.id ?? "");
                const approvable = APPROVABLE.has(String(i.authority ?? ""));
                return (
                  <div className="nrow" key={iid}>
                    {approvable ? (
                      <input
                        type="checkbox"
                        checked={intentSel[iid] === true}
                        disabled={intentBusy}
                        onChange={() => setIntentSel((s) => ({ ...s, [iid]: !s[iid] }))}
                        title="Select for owner approval"
                      />
                    ) : (
                      <span className="note mono" style={{ width: 13 }} />
                    )}
                    <code className="mono">{iid}</code>
                    <span className="note mono">{String(i.category ?? "")}</span>
                    <span className="note" style={{ flex: 1 }}>{String(i.statement ?? "")}</span>
                    <StatusBadge
                      tone={i.authority === "EXPLICIT_OPERATOR" || i.authority === "OWNER_APPROVED" ? "ok" : i.authority === "UNRESOLVED" ? "warn" : "unknown"}
                      label={String(i.authority ?? "")}
                    />
                    <span className="note mono">{String(i.confidence ?? "")}</span>
                  </div>
                );
              })}
              {preview.goal_interpretation.items.some((i) => APPROVABLE.has(String(i.authority ?? ""))) ? (
                <div className="nrow">
                  <button
                    className="tbtn"
                    disabled={intentBusy || !Object.values(intentSel).some(Boolean)}
                    onClick={doApproveIntent}
                  >
                    {intentBusy
                      ? "Approving…"
                      : `Approve ${Object.values(intentSel).filter(Boolean).length || ""} interpretation${Object.values(intentSel).filter(Boolean).length === 1 ? "" : "s"} & re-preview`}
                  </button>
                  <span className="note">
                    approval mints a new governed goal revision — digest-bound, append-only; the original request stays immutable.
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
          <DagView dag={{
            nodes: preview.tasks.map((t) => ({
              task_id: String(t.task_key), task_key: String(t.task_key),
              title: String(t.title ?? t.task_key), status: "PROPOSED",
            })),
            edges: preview.tasks.flatMap((t) =>
              (Array.isArray(t.depends_on) ? t.depends_on : []).map((d) => ({ from: String(d), to: String(t.task_key) }))),
          } as Dag} />
          <div className="actbar">
            <button className="tbtn" disabled={confirmBusy} onClick={() => setConfirming(true)}>
              {confirmBusy ? "Submitting…" : "Confirm & run…"}
            </button>
            <button className="tbtn danger" disabled={confirmBusy} onClick={invalidate}>Discard</button>
            <span className="note">confirm consumes exactly this pinned preview — digest is server-verified.</span>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={confirming && preview !== null}
        title="Confirm mission"
        body={preview ? `Commit mission on project ${preview.project_id}? Pinned preview ${preview.preview_id} (digest ${preview.plan_digest.slice(0, 16)}…). HIGH-IMPACT: starts governed execution.` : ""}
        confirmLabel="Confirm & run"
        busy={confirmBusy}
        onConfirm={() => preview && commit(preview)}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
