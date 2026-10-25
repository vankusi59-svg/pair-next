import { useEffect, useRef, useState } from "react";
import { apiAdmin, ApiError } from "../../api";
import type { AdmissionView, ObjectiveRelation, RelationPreview } from "../../types";
import { StatusBadge, type Tone } from "./StatusBadge";
import { DeniedState, EmptyState, ErrorState, Skeleton } from "./states";
import { ConfirmDialog } from "./ConfirmDialog";

/* P18.1 — Objective relationships section (Objective Detail).
   The admission strip and the edge list render canonical service output
   verbatim — the UI never fabricates edges or gates. The create form's
   preview is ADVISORY ONLY: authority checks run at commit, and the UI
   never sends an owner/actor field (authority is the x-operator-id
   header the api transport sets). Each create mints ONE dedup_key per
   operation signature and replays it verbatim on ambiguous-failure
   retry — the backend dedups on the key. Suspend/resume post directly;
   revoke is terminal → ConfirmDialog. */

type ObjLite = { objective_id: string; title?: string | null; status: string };
type RelKind = "DEPENDS_ON" | "CONFLICTS" | "SUPERSEDES";
type CtlAction = "suspend" | "resume" | "revoke";

type St =
  | { kind: "loading" }
  | {
      kind: "ready";
      forId: string;
      forBiz: string;
      relations: ObjectiveRelation[];
      admission: AdmissionView;
      atMs: number;
    }
  | { kind: "error"; err: ApiError };

type Pv =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: RelationPreview }
  | { kind: "error"; err: ApiError };

const KIND_TONE: Record<string, Tone> = {
  DEPENDS_ON: "warn",
  CONFLICTS: "danger",
  SUPERSEDES: "info",
};
const STATE_TONE: Record<string, Tone> = {
  ACTIVE: "ok",
  SUSPENDED: "warn",
  REVOKED: "danger",
};
const KINDS: RelKind[] = ["DEPENDS_ON", "CONFLICTS", "SUPERSEDES"];
const KIND_HUMAN: Record<RelKind, string> = {
  DEPENDS_ON: "this objective waits on the target",
  CONFLICTS: "the two objectives cannot be admitted together",
  SUPERSEDES: "this objective replaces the target",
};

/* Backend code → owner-actionable gloss. Unknown codes still render
   verbatim (code + detail) — never swallowed. */
const ERR_HINT: Record<string, string> = {
  FAIL_CLOSED_RELATION_AUTHORITY: "you must own both objectives",
  FAIL_CLOSED_RELATION_BUSINESS: "relations cannot span businesses",
  FAIL_CLOSED_RELATION_OBJECTIVE: "the target is not a canonical objective of this business",
  FAIL_CLOSED_RELATION_CYCLE: "a dependency edge cannot create a cycle",
  FAIL_CLOSED_RELATION_STATE: "state changed — refresh and retry",
  FAIL_CLOSED_RELATION_KIND: "unsupported relation kind",
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

export function ObjectiveRelations(props: {
  objectiveId: string;
  businessId: string;
  objectives: ObjLite[];
  onChanged?: () => void;
}): JSX.Element {
  const { objectiveId, businessId } = props;
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [mutBusy, setMutBusy] = useState(false);
  const [mutNote, setMutNote] = useState<string | null>(null);
  const [dlg, setDlg] = useState<ObjectiveRelation | null>(null);
  const [cTarget, setCTarget] = useState("");
  const [cKind, setCKind] = useState<RelKind>("DEPENDS_ON");
  const [cNote, setCNote] = useState("");
  const [pv, setPv] = useState<Pv>({ kind: "idle" });
  const lastApplied = useRef(0);
  const opSeq = useRef(0);
  /* Minted-once dedup keys keyed by operation signature — an ambiguous
     retry replays the stored key so a committed-but-lost response can
     never double-mint the edge. */
  const dedupKeys = useRef<Record<string, string>>({});
  const onChangedRef = useRef(props.onChanged);
  onChangedRef.current = props.onChanged;

  /* Identity change (objective or business) closes the dialog, wipes
     every form field, and bumps the in-flight guard — a stale mutation
     can never attribute to a different identity. */
  useEffect(() => {
    setDlg(null);
    setMutNote(null);
    setMutBusy(false);
    setCTarget("");
    setCKind("DEPENDS_ON");
    setCNote("");
    setPv({ kind: "idle" });
    lastApplied.current = 0;
    dedupKeys.current = {};
    opSeq.current++;
  }, [objectiveId, businessId]);

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
    /* Silent re-poll: keep the last good snapshot for THIS identity
       while refetching; collapse to loading only on identity change
       or before the first successful read. */
    setSt((prev) =>
      prev.kind === "ready" && prev.forId === objectiveId && prev.forBiz === businessId
        ? prev
        : { kind: "loading" },
    );
    if (!objectiveId || !businessId) return;
    const ctl = new AbortController();
    apiAdmin
      .objectiveRelationsApp(objectiveId, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const atMs = Date.now();
        if (atMs <= lastApplied.current) return;
        lastApplied.current = atMs;
        setSt({
          kind: "ready",
          forId: objectiveId,
          forBiz: businessId,
          relations: arr(r.relations).filter(
            (x) => x !== null && typeof x === "object" && !!x.relation_id,
          ),
          admission: r.admission ?? { upstream: [], conflicts: [], superseded_by: [] },
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
  }, [objectiveId, businessId, tick]);

  const relations = st.kind === "ready" ? st.relations : [];

  /* A target is already linked for the selected kind when a non-REVOKED
     edge of that kind covers the pair — CONFLICTS is symmetric so it
     counts in either direction. */
  const linkedFor = (kind: RelKind, target: string): boolean =>
    relations.some(
      (r) =>
        r.kind === kind &&
        r.state !== "REVOKED" &&
        ((r.from_objective_id === objectiveId && r.to_objective_id === target) ||
          (kind === "CONFLICTS" && r.from_objective_id === target && r.to_objective_id === objectiveId)),
    );

  /* Clamp the form: a target that becomes ineligible (kind change, new
     canonical edge) is dropped — never submitted silently. */
  useEffect(() => {
    if (cTarget && (cTarget === objectiveId || linkedFor(cKind, cTarget))) setCTarget("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cKind, cTarget, objectiveId, st]);

  /* Advisory preview — fired when a target is selected. The seam takes
     no AbortSignal; the dead flag drops late/foreign responses, and the
     response identity must match the request (fail-closed, same as the
     canonical reads). */
  useEffect(() => {
    if (!objectiveId || !cTarget) {
      setPv({ kind: "idle" });
      return;
    }
    const target = cTarget;
    const kind = cKind;
    let dead = false;
    setPv({ kind: "loading" });
    apiAdmin
      .previewRelationApp(objectiveId, { to_objective_id: target, kind })
      .then((r) => {
        if (dead) return;
        if (
          String(r.from_objective_id) !== objectiveId ||
          String(r.to_objective_id) !== target ||
          String(r.kind) !== kind
        ) {
          setPv({
            kind: "error",
            err: new ApiError(0, "IDENTITY_MISMATCH", "Advisory preview response does not match the requested relation."),
          });
          return;
        }
        setPv({ kind: "ready", data: r });
      })
      .catch((e: unknown) => {
        if (dead) return;
        setPv({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => {
      dead = true;
    };
  }, [objectiveId, cTarget, cKind]);

  const runCtl = (rel: ObjectiveRelation, action: CtlAction) => {
    const seq = ++opSeq.current;
    setDlg(null);
    setMutBusy(true);
    setMutNote(null);
    apiAdmin
      .relationControlApp(rel.relation_id, action)
      .then((r) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        const rr = r?.relation;
        if (!rr || String(rr.relation_id) !== rel.relation_id) {
          setMutNote(
            `Relation ${action} returned an inconsistent response — canonical list refetched; verify state before retrying.`,
          );
        } else {
          setMutNote(`Relation ${action} committed — canonical list refreshed.`);
        }
        setTick((n) => n + 1);
        onChangedRef.current?.();
      })
      .catch((e: unknown) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        setMutNote(`Relation ${action} failed: ${describeErr(e)}`);
        // A committed-but-lost lifecycle lands as FAIL_CLOSED_*_STATE —
        // re-tick the poll so the canonical row repaints immediately
        // instead of waiting out the 8s interval.
        if (e instanceof ApiError && e.code.endsWith("_STATE")) setTick((n) => n + 1);
      });
  };

  const submitCreate = () => {
    if (!objectiveId || !cTarget || mutBusy) return;
    const target = cTarget;
    const kind = cKind;
    const note = cNote.trim();
    const seq = ++opSeq.current;
    /* Operation signature = the semantic body. An unchanged retry of
       the SAME operation replays the stored dedup_key verbatim; the
       ledger dedups so a committed-but-lost response cannot double-mint.
       Different inputs are a different operation → fresh key. */
    const sig = JSON.stringify(["rel", objectiveId, target, kind]);
    let key = dedupKeys.current[sig];
    if (!key) {
      key = `ui-rel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      dedupKeys.current[sig] = key;
    }
    setMutBusy(true);
    setMutNote(null);
    apiAdmin
      .createRelationApp(objectiveId, {
        to_objective_id: target,
        kind,
        note: note || undefined,
        dedup_key: key,
      })
      .then((r) => {
        if (seq !== opSeq.current) return;
        delete dedupKeys.current[sig];
        setMutBusy(false);
        const rel = r?.relation;
        setMutNote(
          `Relation committed${rel && rel.relation_id ? ` (${rel.relation_id})` : ""} — canonical list refreshed.`,
        );
        setCTarget("");
        setCNote("");
        setTick((n) => n + 1);
        onChangedRef.current?.();
      })
      .catch((e: unknown) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        const definitive = e instanceof ApiError && e.status >= 400 && e.status < 500;
        /* A definitive 4xx rejection kills the stored op — a corrected
           submit mints a fresh key. An ambiguous transport/5xx failure
           keeps it for exact-body replay. */
        if (definitive) delete dedupKeys.current[sig];
        setMutNote(
          `Create relation failed: ${describeErr(e)}${
            !definitive ? " — result ambiguous; the same dedup_key is kept for retry" : ""
          }`,
        );
      });
  };

  const titleOf = (id: string): string => {
    const o = props.objectives.find((x) => x.objective_id === id);
    return (o && o.title ? String(o.title) : "") || id;
  };

  if (!objectiveId) {
    return (
      <section aria-label="objective relationships">
        <h2 className="sech">Objective relationships</h2>
        <EmptyState title="No objective" detail="Relations render inside an objective context." />
      </section>
    );
  }

  /* Render-boundary identity guard: only data fetched for THIS
     objective/business paints — anything else is stale-for-this-view. */
  const ready = st.kind === "ready" && st.forId === objectiveId && st.forBiz === businessId ? st : null;
  const adm = ready ? ready.admission : null;
  const targets = props.objectives.filter(
    (o) => o.objective_id !== objectiveId && !linkedFor(cKind, o.objective_id),
  );
  const pvValid = pv.kind === "ready" && pv.data.valid === true;

  const admRow = (label: string, ids: string[]) => (
    <div className="nrow">
      <span className="tt">{label}</span>
      {ids.length === 0 ? (
        <span className="note">no gates</span>
      ) : (
        ids.map((id) => (
          <span className="tt" key={id} title={id}>
            {titleOf(id)}
          </span>
        ))
      )}
    </div>
  );

  return (
    <section aria-label="objective relationships">
      <h2 className="sech">Objective relationships</h2>
      <div className="sub">
        Canonical dependency, conflict and supersession edges for {objectiveId}. The admission strip
        is the strict gate input; edge lifecycle changes commit through the canonical control seam.
      </div>

      {mutNote ? (
        <div className="trunc" role="status">
          {mutNote}
        </div>
      ) : null}

      {ready === null ? (
        st.kind === "error" ? (
          st.err.status === 403 ? (
            <DeniedState detail={`${st.err.detail || "You don't own this objective."} (${st.err.code})`} />
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
          <>
            <div className="sub">Loading relations…</div>
            <div className="need">
              {[0, 1].map((i) => (
                <div className="nrow" key={i}>
                  <Skeleton height={12} width="55%" />
                </div>
              ))}
            </div>
          </>
        )
      ) : (
        <>
          <div className="need" aria-label="admission view — canonical gate input">
            {admRow("must wait on", arr(adm?.upstream))}
            {admRow("conflicts with", arr(adm?.conflicts))}
            {admRow("superseded by", arr(adm?.superseded_by))}
          </div>

          <div className="need" aria-label="relation edges">
            {relations.length === 0 ? (
              <div className="nrow">
                <span className="note">No relations — dependencies appear here.</span>
              </div>
            ) : null}
            {relations.map((r) => (
              <div className="nrow" key={r.relation_id}>
                <StatusBadge tone={KIND_TONE[r.kind] ?? "unknown"} label={r.kind} />
                <span className="tt" title={r.from_objective_id}>
                  {titleOf(r.from_objective_id)}
                </span>
                <span className="note" aria-hidden>
                  →
                </span>
                <span className="tt" title={r.to_objective_id}>
                  {titleOf(r.to_objective_id)}
                </span>
                <StatusBadge tone={STATE_TONE[r.state] ?? "unknown"} label={r.state} />
                <span className="note">
                  {r.note ? `${String(r.note)} · ` : ""}created {fmtD(r.created_at)}
                </span>
                {r.state === "ACTIVE" ? (
                  <button className="ghost" disabled={mutBusy} onClick={() => runCtl(r, "suspend")}>
                    Suspend
                  </button>
                ) : null}
                {r.state === "SUSPENDED" ? (
                  <button className="ghost" disabled={mutBusy} onClick={() => runCtl(r, "resume")}>
                    Resume
                  </button>
                ) : null}
                {r.state !== "REVOKED" ? (
                  <button className="ghost" disabled={mutBusy} onClick={() => setDlg(r)}>
                    Revoke
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}

      <section className="oform" aria-label="create relation">
        <div className="ofrow">
          <label htmlFor="rel-to">target objective</label>
          <select id="rel-to" value={cTarget} onChange={(e) => setCTarget(e.target.value)}>
            <option value="">— select target —</option>
            {targets.map((o) => (
              <option key={o.objective_id} value={o.objective_id}>
                {(o.title ? String(o.title) : o.objective_id)} · {o.status}
              </option>
            ))}
          </select>
          {targets.length === 0 ? (
            <span className="note">
              No eligible targets for {cKind} — every other objective is already linked by an active
              edge of this kind, or none exist.
            </span>
          ) : null}
        </div>
        <div className="ofrow2">
          <div className="ofrow">
            <label htmlFor="rel-kind">kind</label>
            <select id="rel-kind" value={cKind} onChange={(e) => setCKind(e.target.value as RelKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="ofrow">
            <label htmlFor="rel-note">note (optional)</label>
            <input
              id="rel-note"
              value={cNote}
              onChange={(e) => setCNote(e.target.value)}
              placeholder="why this edge exists"
            />
          </div>
        </div>
        <div className="sub" style={{ marginBottom: 0 }}>
          {KIND_HUMAN[cKind]} — authored from this objective outward.
        </div>

        {pv.kind === "loading" ? (
          <div className="ofrow">
            <span className="note">advisory preview loading…</span>
          </div>
        ) : null}
        {pv.kind === "ready" ? (
          <div className="ofrow" aria-label="advisory relation preview">
            <div>
              <StatusBadge
                tone={pvValid ? "ok" : "danger"}
                label={pvValid ? "advisory: valid" : "advisory: invalid"}
              />{" "}
              <span className="note">Advisory preview — authority checks run at commit</span>
            </div>
            {arr(pv.data.errors).map((err, i) => (
              <div className="note" key={i} style={{ color: "var(--danger)" }} role="alert">
                {String(err)}
              </div>
            ))}
            {Object.entries(pv.data.implications ?? {}).map(([k, v]) => (
              <div className="note" key={k}>
                {k}: {typeof v === "string" ? v : JSON.stringify(v)}
              </div>
            ))}
            {pv.data.current ? (
              <div className="note">
                current: {pv.data.current.relations} relation(s)
                {pv.data.current.admission
                  ? ` · upstream ${arr(pv.data.current.admission.upstream).length} · conflicts ${arr(pv.data.current.admission.conflicts).length} · superseded_by ${arr(pv.data.current.admission.superseded_by).length}`
                  : ""}
              </div>
            ) : null}
          </div>
        ) : null}
        {pv.kind === "error" ? (
          <div className="trunc" role="alert">
            Advisory preview failed: {describeErr(pv.err)} — submit stays disabled.
          </div>
        ) : null}

        <div className="actions">
          <button
            className="primary"
            disabled={mutBusy || !cTarget || !pvValid}
            title={
              !cTarget
                ? "Select a target objective first"
                : !pvValid
                  ? "The advisory preview must report valid — authority checks still run at commit"
                  : "Commit the canonical relation edge"
            }
            onClick={submitCreate}
          >
            {mutBusy ? "Working…" : "Create relation"}
          </button>
        </div>
        <div className="sub">
          Commits only to_objective_id / kind / note / dedup_key — the backend derives authority from
          your operator identity and re-validates everything at commit.
        </div>
      </section>

      <ConfirmDialog
        open={dlg !== null}
        title="Revoke relation"
        body={
          dlg
            ? `Revoke ${dlg.kind} ${titleOf(dlg.from_objective_id)} → ${titleOf(dlg.to_objective_id)} (${dlg.relation_id})? Revoking removes this edge's authority permanently — a revoked relation cannot be resumed. The row remains as a tombstone in the canonical list.`
            : ""
        }
        confirmLabel="Revoke relation"
        busy={mutBusy}
        onConfirm={() => {
          if (dlg) runCtl(dlg, "revoke");
        }}
        onCancel={() => setDlg(null)}
      />
    </section>
  );
}
