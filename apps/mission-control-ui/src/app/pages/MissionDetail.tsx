import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, apiAdmin } from "../../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorState, Skeleton } from "../components/states";
import { StatusBadge } from "../components/StatusBadge";
import { DagView } from "../../components/Dag";
import type { Dag, MissionDetail as Detail, MissionFileRow, TimelineEntry } from "../types";

/* P15.9-B5.3 — Mission Detail. Primary read verifies the returned
   mission identity === URL id before rendering. Subordinate reads
   (dag/timeline/evidence/files) settle independently with element
   validation; malformed → UNAVAILABLE, never a fake empty section.
   Lifecycle actions via pinned ConfirmDialog only — no optimistic
   state, canonical refetch after success. */

type Section<T> = { kind: "ready"; data: T } | { kind: "unavailable"; code: string };
/* R2-B: lineage evidence is tri-state — a proven canonical chain yields the
   backlink; anything else is an honest unproven note (never a guess). */
type Lineage =
  | { kind: "proven"; objective_id: string; work_item_id: string; open_id: string }
  | { kind: "unproven"; reason: string };

/* R1-F3: validate a mission-detail collection before rendering —
   non-array / non-object / identity-less elements = MALFORMED, never a
   fabricated canonical empty list. */
function collSec(v: unknown, idf: (e: Record<string, unknown>) => boolean): Section<Array<Record<string, unknown>>> {
  if (!Array.isArray(v)) return { kind: "unavailable", code: "MALFORMED" };
  if (!v.every((e) => e !== null && typeof e === "object" && idf(e as Record<string, unknown>))) {
    return { kind: "unavailable", code: "MALFORMED" };
  }
  return { kind: "ready", data: v as Array<Record<string, unknown>> };
}
type Dlg = { op: "pause" | "resume" | "cancel" | "acknowledge"; mission: string; state: string };

type St =
  | { kind: "loading" }
  | {
      kind: "ready";
      forId: string;
      detail: Detail;
      dag: Section<Dag>;
      timeline: Section<TimelineEntry[]>;
      evidence: Section<Array<Record<string, unknown>>>;
      files: Section<MissionFileRow[]>;
      lineage: Lineage | null;
    }
  | { kind: "error"; err: ApiError };

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "ABORTED"]);
const rowOk = (e: unknown, idf: string) =>
  e !== null && typeof e === "object" && (e as Record<string, unknown>)[idf] != null;

function sect<I, O extends unknown[]>(
  r: PromiseSettledResult<I>, pick: (v: I) => O | null, idf?: string,
): Section<O> {
  if (r.status === "rejected") {
    return { kind: "unavailable", code: r.reason instanceof ApiError ? r.reason.code : "ERROR" };
  }
  try {
    const v = r.value;
    const out = pick(v);
    if (out === null || !Array.isArray(out)) return { kind: "unavailable", code: "MALFORMED" };
    if (idf && !out.every((e) => rowOk(e, idf))) return { kind: "unavailable", code: "MALFORMED" };
    return { kind: "ready", data: out };
  } catch {
    return { kind: "unavailable", code: "MALFORMED" };
  }
}

export function MissionDetailPage() {
  const { id = "" } = useParams();
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [mutBusy, setMutBusy] = useState(false);
  const [mutNote, setMutNote] = useState<string | null>(null);
  const [fileView, setFileView] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const seq = useRef(0);
  const lastIdent = useRef<string | null>(null);

  useEffect(() => {
    const identChanged = lastIdent.current !== id;
    lastIdent.current = id;
    /* R1-F4: mission switch invalidates every outstanding mutation/file
       generation — an in-flight result for A can never land on B. */
    if (identChanged) seq.current++;
    setDlg(null); setMutBusy(false); setFileView(null); setFileErr(null);
    if (identChanged) setMutNote(null); /* post-mutation notes survive a canonical refetch */
    setSt({ kind: "loading" });
    if (!id) return;
    const ctl = new AbortController();
    (async () => {
      /* primary read first — verify identity before any subordinate GETs */
      let d: Detail;
      try {
        d = await apiAdmin.missionDetail(id, ctl.signal);
      } catch (e) {
        if (ctl.signal.aborted) return;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
        return;
      }
      if (ctl.signal.aborted) return;
      const mid = d && typeof d === "object" ? String((d.mission as Record<string, unknown> | undefined)?.mission_id ?? "") : "";
      if (!mid || mid !== id) {
        setSt({ kind: "error", err: new ApiError(200, mid ? "IDENTITY_MISMATCH" : "MALFORMED",
          mid ? `detail payload is for ${mid}, not ${id} — discarded` : "malformed mission detail payload") });
        return;
      }
      /* identity verified → subordinate reads settle independently */
      const miMeta = (d.mission.metadata ?? {}) as Record<string, unknown>;
      /* R1-F1 canonical lineage chain (no new backend route):
         mission.bound_open_id is a work_open_binding.open_id — NOT an
         objective_id. Proven chain: bound_open_id === the mission's own
         server-stamped metadata.work_item_open_id mirror AND
         metadata.work_item_id resolves via GET /api/work-items (scoped
         by the stamped business_id when present) to a row whose
         objective_id is real. Any break → omit the backlink. */
      const openId = String((d.mission.bound_open_id as string | undefined) ?? "");
      const wiId = String(miMeta.work_item_id ?? "");
      const wiOpen = String(miMeta.work_item_open_id ?? "");
      const bizId = String(miMeta.business_id ?? "");
      /* business_id mirror must exist for the scoped work-items read —
         without it the chain cannot be proven, so the backlink is
         omitted (never an unfiltered guess). */
      const wantLineage = openId !== "" && wiOpen === openId && wiId !== "" && bizId !== "";
      const [dagR, tlR, evR, fR, wiR] = await Promise.allSettled([
        apiAdmin.missionDag(id, ctl.signal),
        apiAdmin.missionTimeline(id, ctl.signal),
        apiAdmin.missionEvidence(id, ctl.signal),
        apiAdmin.missionFiles(id, ctl.signal),
        wantLineage ? apiAdmin.workItems(bizId, ctl.signal) : Promise.resolve(null),
      ]);
      if (ctl.signal.aborted) return;
      /* R2-B: the scoped work-items response is lineage EVIDENCE —
         envelope, array and every row are validated. Malformed rows
         (null / primitive / missing identity or scope) or a wrong-business
         row fail closed: the backlink is omitted with an honest unproven
         note; other sections stay available. */
      let lineage: Lineage | null = null;
      if (wantLineage) {
        if (wiR.status === "rejected" || !wiR.value) {
          const code = wiR.status === "rejected"
            ? (wiR.reason instanceof ApiError ? wiR.reason.code : "ERROR")
            : "EMPTY";
          lineage = { kind: "unproven", reason: `lineage evidence unavailable (${code}) — backlink omitted` };
        } else {
          const env = wiR.value as Record<string, unknown>;
          const wis = env !== null && typeof env === "object" ? (env as { work_items?: unknown }).work_items : undefined;
          if (!Array.isArray(wis)) {
            lineage = { kind: "unproven", reason: "lineage evidence malformed (work_items not an array) — backlink omitted" };
          } else if (!wis.every((w) => w !== null && typeof w === "object"
            && (w as Record<string, unknown>).work_item_id != null
            && (w as Record<string, unknown>).business_id != null)) {
            lineage = { kind: "unproven", reason: "lineage evidence malformed (invalid work-item rows) — backlink omitted" };
          } else {
            const wi = (wis as Array<Record<string, unknown>>).find((w) => String(w.work_item_id) === wiId);
            if (!wi) {
              lineage = { kind: "unproven", reason: `work item ${wiId} not resolved by the scoped read — backlink omitted` };
            } else if (String(wi.business_id) !== bizId) {
              lineage = { kind: "unproven", reason: `work item ${wiId} resolved outside business ${bizId} — scope unproven, backlink omitted` };
            } else {
              const objId = String(wi.objective_id ?? "");
              lineage = objId
                ? { kind: "proven", objective_id: objId, work_item_id: wiId, open_id: openId }
                : { kind: "unproven", reason: `work item ${wiId} carries no objective_id — backlink omitted` };
            }
          }
        }
      }
      const dagSec = (() => {
        const s = sect(dagR, (v) => (v && Array.isArray(v.nodes) && Array.isArray(v.edges) ? [v as Dag] : null));
        /* deeper: every node needs task_id+task_key; edges need from/to */
        if (s.kind === "ready") {
          const dg = s.data[0];
          const ok = dg.nodes.every((n) => rowOk(n, "task_id") && n.task_key != null)
            && dg.edges.every((e) => e !== null && typeof e === "object" && typeof e.from === "string" && typeof e.to === "string");
          return ok ? { kind: "ready" as const, data: dg } : { kind: "unavailable" as const, code: "MALFORMED" };
        }
        return s;
      })();
      setSt({
        kind: "ready",
        forId: id,
        detail: d,
        dag: dagSec,
        timeline: sect(tlR, (v) => (Array.isArray(v) ? v : null), "at"),
        evidence: sect(evR, (v) => (Array.isArray(v) ? v : null), "kind"),
        files: sect(fR, (v) => (v && Array.isArray(v.files) ? v.files : null), "path"),
        lineage,
      });
    })();
    return () => ctl.abort();
  }, [id, tick]);

  const submit = async () => {
    if (!dlg || mutBusy || dlg.mission !== id) return;
    const d = dlg;
    const s = ++seq.current;
    setMutBusy(true);
    setMutNote(null);
    try {
      await apiAdmin.missionAction(d.mission, d.op);
      /* R1-F4: a mutation result for mission A must never land on B */
      if (s !== seq.current || d.mission !== lastIdent.current) return;
      setMutNote(`${d.op} accepted by the backend — canonical state refetched.`);
      setTick((t) => t + 1);
    } catch (e) {
      if (s !== seq.current) return;
      if (s === seq.current && d.mission === lastIdent.current) {
        setMutNote(
          e instanceof ApiError
            ? e.status === 0 || e.status >= 500
              ? `${d.op} result AMBIGUOUS (${e.code}) — may have committed; canonical state refetch required before retrying.`
              : `${d.op} failed: ${e.detail || e.message} (${e.code})`
            : `${d.op} result AMBIGUOUS — ${String(e)}`,
        );
      }
    } finally {
      if (s === seq.current) setMutBusy(false);
    }
    setDlg(null);
  };

  if (st.kind === "error") return <ErrorState code={st.err.code} detail={st.err.detail} />;
  if (st.kind === "loading" || st.forId !== id) {
    return <div className="page"><h1>Mission {id.slice(0, 24)}</h1><Skeleton height={18} /><Skeleton height={240} /></div>;
  }

  const d = st.detail;
  const mission = d.mission as Record<string, unknown>;
  const rt = (d.runtime ?? {}) as Record<string, unknown>;
  const state = String(rt.state ?? mission.state ?? mission.status ?? "");
  /* R1-F3: collection integrity — malformed rows never render as a
     canonical empty list; sections stay independent. */
  const tasksSec = collSec(d.tasks, (e) => e.task_key != null || e.task_id != null);
  const execsSec = collSec(d.executions, (e) => e.execution_id != null);
  const apprSec = collSec(d.approvals_pending, (e) => e.approval_id != null || e.entity_id != null);
  const tasks = tasksSec.kind === "ready" ? tasksSec.data : [];
  const execs = execsSec.kind === "ready" ? execsSec.data : [];
  const approvals = apprSec.kind === "ready" ? apprSec.data : [];
  const lineage = st.lineage;

  const unv = (label: string, code: string) => (
    <div className="need"><div className="nrow"><StatusBadge tone="warn" label="UNAVAILABLE" /><span className="note">{label} unavailable ({code}) — not shown as empty.</span></div></div>
  );

  return (
    <div className="page">
      <h1>Mission <span className="mono">{id}</span></h1>
      <p className="sub srcnote">Canonical reads only — every action below POSTs through the existing lifecycle endpoints after an explicit confirmation.</p>

      {lineage?.kind === "proven" ? (
        <div className="nrow" style={{ margin: "6px 0" }}>
          <Link className="lnk" to={`/app/objectives/${encodeURIComponent(lineage.objective_id)}`}>← Objective {lineage.objective_id}</Link>
          <span className="note">(verified via bound_open_id → work item {lineage.work_item_id} → objective — never constructed from the open id alone)</span>
        </div>
      ) : mission.bound_open_id ? (
        <div className="nrow" style={{ margin: "6px 0" }}>
          <span className="note">{lineage?.kind === "unproven"
            ? lineage.reason
            : "bound_open_id present but objective lineage unproven — backlink omitted (no guessing)."}</span>
        </div>
      ) : null}

      <div className="need">
        <div className="nrow"><span className="tt">State</span><StatusBadge tone={state === "RUNNING" ? "purple" : TERMINAL.has(state) ? (state === "COMPLETED" ? "ok" : "danger") : "info"} label={state || "—"} /></div>
        <div className="nrow"><span className="tt">Goal</span><span>{String(mission.goal ?? "")}</span></div>
        <div className="nrow">
          <span className="note mono">project {String(mission.project_id ?? "—")} · created {String(mission.created_at ?? "").replace("T", " ").slice(0, 19)} · tasks {String(d.task_count ?? tasks.length)}</span>
        </div>
        <div className="nrow actbar">
          {state === "RUNNING" ? <button className="tbtn" onClick={() => setDlg({ op: "pause", mission: id, state })}>Pause…</button> : null}
          {state === "PAUSED" ? <button className="tbtn" onClick={() => setDlg({ op: "resume", mission: id, state })}>Resume…</button> : null}
          {!TERMINAL.has(state) ? <button className="tbtn danger" onClick={() => setDlg({ op: "cancel", mission: id, state })}>Cancel…</button> : null}
          {TERMINAL.has(state) ? <button className="tbtn" onClick={() => setDlg({ op: "acknowledge", mission: id, state })}>Acknowledge…</button> : null}
          <span className="note">actions follow the canonical lifecycle contract — eligibility re-checked server-side.</span>
        </div>
      </div>
      {mutNote ? <div className="trunc" role="status">{mutNote}</div> : null}

      <h2 className="sech">Task graph</h2>
      {st.dag.kind === "unavailable" ? unv("DAG", st.dag.code) : <DagView dag={st.dag.data} />}

      {tasksSec.kind === "unavailable" ? unv("tasks collection", tasksSec.code) : (
        <>
          <h2 className="sech">Tasks ({tasks.length})</h2>
          <div className="need">
            {tasks.map((t) => (
              <div className="nrow" key={String(t.task_id ?? t.task_key)}>
                <code className="mono">{String(t.task_key ?? "")}</code>
                <span style={{ flex: 1 }}>{String(t.task_instruction ?? t.title ?? "")}</span>
                <span className="note">{t.selected_executor ? `→ ${String(t.selected_executor)}` : ""}</span>
                <StatusBadge tone="info" label={String(t.status ?? "—")} />
              </div>
            ))}
          </div>
        </>
      )}

      {execsSec.kind === "unavailable" ? unv("executions collection", execsSec.code) : (
        <>
          <h2 className="sech">Executions ({execs.length})</h2>
          <div className="need">
            {execs.map((x) => {
          const arts = Array.isArray(((x.result ?? {}) as Record<string, unknown>).artifacts)
            ? (((x.result ?? {}) as Record<string, unknown>).artifacts as Array<Record<string, unknown>>) : [];
          return (
            <div className="nrow" key={String(x.execution_id)}>
              <code className="mono">{String(x.execution_id).slice(0, 24)}</code>
              <span>{String(x.executor_id ?? "—")}</span>
              <StatusBadge tone="info" label={String(x.execution_state ?? "—")} />
              <span className="note mono">{arts.map((a) => String(a.path ?? "")).join(", ") || "—"}</span>
            </div>
          );
        })}
          </div>
        </>
      )}

      <h2 className="sech">Workspace files</h2>
      {st.files.kind === "unavailable" ? unv("file listing", st.files.code) : st.files.data.length === 0 ? (
        <div className="need"><div className="nrow"><span className="note">No files in the mission workspace yet.</span></div></div>
      ) : (
        <div className="need">
          {st.files.data.map((f) => (
            <div className="nrow" key={String(f.path)}>
              <button className="lnk mono" style={{ background: "none", border: 0, cursor: "pointer", padding: 0 }}
                onClick={async () => {
                  /* R1-F4: pin the read to mission + generation — a late
                     result for A never lands on B's page or another file. */
                  const fs = ++seq.current;
                  const forId = id;
                  const forPath = String(f.path);
                  setFileErr(null);
                  setFileView(null);
                  try {
                    const r = await apiAdmin.missionFile(forId, forPath);
                    if (fs !== seq.current || forId !== lastIdent.current) return;
                    if (r && typeof r === "object" && typeof r.content === "string") {
                      setFileView({ path: String(r.path ?? forPath), content: r.content, truncated: r.truncated === true });
                    } else setFileErr("malformed file response");
                  } catch (e) {
                    if (fs !== seq.current || forId !== lastIdent.current) return;
                    setFileErr(e instanceof ApiError ? `${e.detail || e.message} (${e.code})` : String(e));
                  }
                }}>{String(f.path)}</button>
              <span className="note">{Number(f.size)} B · {String(f.modified_at ?? "").replace("T", " ").slice(0, 19)}</span>
            </div>
          ))}
          <div className="nrow"><span className="note">read-only — a workspace file is not automatically a verified canonical artifact.</span></div>
        </div>
      )}
      {fileErr ? <div className="need"><div className="nrow"><StatusBadge tone="danger" label="ERROR" /><span className="note">{fileErr}</span></div></div> : null}
      {fileView ? (
        <div className="need">
          <div className="nrow"><strong className="mono">{fileView.path}</strong>
            <button className="tbtn" onClick={() => setFileView(null)}>close</button></div>
          <pre className="note" style={{ whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto" }}>{fileView.content}</pre>
          {fileView.truncated ? <div className="nrow"><span className="note">… truncated (server-reported limit).</span></div> : null}
        </div>
      ) : null}

      {apprSec.kind === "unavailable" ? unv("approvals collection", apprSec.code) : approvals.length > 0 ? (
        <>
          <h2 className="sech">Pending approvals ({approvals.length})</h2>
          <div className="need">
            {approvals.map((a) => (
              <div className="nrow" key={String(a.approval_id ?? a.entity_id)}>
                <code className="mono">{String(a.approval_id ?? a.entity_id)}</code>
                <span>{String(a.reason ?? a.kind ?? "")}</span>
                <Link className="lnk" to="/app/inbox">decide in Owner Inbox →</Link>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <h2 className="sech">Timeline</h2>
      {st.timeline.kind === "unavailable" ? unv("timeline", st.timeline.code) : st.timeline.data.length === 0 ? (
        <div className="need"><div className="nrow"><span className="note">No timeline entries.</span></div></div>
      ) : (
        <div className="need">
          {st.timeline.data.map((e, i) => (
            <div className="nrow" key={i}>
              <StatusBadge tone={e.kind === "EVIDENCE" ? "ok" : "info"} label={e.kind} />
              <span className="note">{String(e.at ?? "").replace("T", " ").slice(0, 19)}</span>
              <span>{String(e.event_type ?? e.evidence_kind ?? e.entity ?? "")}</span>
              <span className="note">{e.new_state ? `→ ${e.new_state}` : ""}{e.actor ? ` · ${e.actor}` : ""}</span>
            </div>
          ))}
        </div>
      )}

      <h2 className="sech">Evidence</h2>
      {st.evidence.kind === "unavailable" ? unv("evidence", st.evidence.code) : st.evidence.data.length === 0 ? (
        <div className="need"><div className="nrow"><span className="note">No evidence entries.</span></div></div>
      ) : (
        <div className="need">
          {st.evidence.data.map((e, i) => (
            <div className="nrow" key={i}>
              <span className="tt">{String(e.kind ?? "—")}</span>
              <code className="note mono">{String(e.entity_id ?? "")}</code>
              <span className="note">{String(e.created_at ?? "").replace("T", " ").slice(0, 19)}</span>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={dlg !== null}
        title={dlg ? `${dlg.op} mission` : ""}
        body={dlg ? (dlg.op === "cancel"
          ? `CANCEL ${dlg.mission} (observed state: ${dlg.state})? HIGH-IMPACT: commits the canonical cancel transition — running work is torn down.`
          : `${dlg.op.toUpperCase()} ${dlg.mission} (observed state: ${dlg.state})? Commits the canonical ${dlg.op} lifecycle transition.`) : ""}
        confirmLabel={dlg?.op ?? "confirm"}
        busy={mutBusy}
        onConfirm={submit}
        onCancel={() => setDlg(null)}
      />
    </div>
  );
}
