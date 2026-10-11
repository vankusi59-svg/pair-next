import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import { invalidateInboxCounts } from "../lib/inboxCounts";
import type { CompanyPayload } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { DeniedState, EmptyState, ErrorState, Skeleton } from "../components/states";
import { ConfirmDialog } from "../components/ConfirmDialog";

/* P15.9-B4 — Owner Inbox (D.6/E.5): three lanes.
   REVIEWS: fresh pending via company.objectives[].latest_review.
   owner_action_required (server pin-checked — NEVER derived from
   historical /reviews rows or CANDIDATE outcomes); exact total =
   counts.targets_met_pending.
   APPROVALS: global queue, NOT business-scoped — labeled as such;
   works independently of business selection.
   HALT: no enumeration endpoint exists → API_MISSING, never a count. */

type Filter = "all" | "approval" | "review" | "halt";
const TERMINAL = new Set(["ACHIEVED", "CANCELLED", "FAILED"]);

type St =
  | { kind: "no-business" }
  | { kind: "loading" }
  | { kind: "ready"; data: CompanyPayload; forBiz: string }
  | { kind: "error"; err: ApiError };

type AprSt =
  | { kind: "loading" }
  | { kind: "ready"; rows: Array<Record<string, unknown>> }
  | { kind: "error"; err: ApiError };

export function Inbox() {
  const { biz } = useSelectedBusiness();
  const [sp, setSp] = useSearchParams();
  const filter: Filter = (["all", "approval", "review", "halt"] as const).includes(
    (sp.get("lane") ?? "all") as Filter,
  )
    ? ((sp.get("lane") ?? "all") as Filter)
    : "all";

  const [st, setSt] = useState<St>({ kind: "loading" });
  const [apr, setApr] = useState<AprSt>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [mutNote, setMutNote] = useState<string | null>(null);
  const [mutBusy, setMutBusy] = useState(false);
  /* R1-F2 — the full canonical decision context is PINNED when the
     dialog opens: approvalId, action and the row's recorded scope,
     verbatim. `scopeOk` distinguishes a valid empty scope `{}` from a
     missing/malformed one — never silently substituted, and confirm
     is disabled (fail closed) when it isn't canonical. */
  const [dlg, setDlg] = useState<{
    action: "approve" | "deny";
    approvalId: string;
    scope: Record<string, unknown>;
    scopeOk: boolean;
    scopeDigest: string | null;
    mission: string | null;
    reason: string | null;
    requested: string | null;
  } | null>(null);
  /* A2 — review sign-off dialog. The canonical review pin (review_id,
     outcome, recommended_status) is captured verbatim from the
     company projection when the dialog opens; backend re-validation
     remains authoritative (fresh pins, latest review, active work). */
  const [rdlg, setRdlg] = useState<{
    objectiveId: string;
    title: string;
    reviewId: string;
    outcome: string;
    recommended: string | null;
  } | null>(null);
  const opSeq = useRef(0);

  const openDecide = (a: Record<string, unknown>, action: "approve" | "deny") => {
    const id = String(a.approval_id ?? a.entity_id);
    const scopeOk =
      Object.prototype.hasOwnProperty.call(a, "scope") &&
      typeof a.scope === "object" &&
      a.scope !== null &&
      !Array.isArray(a.scope);
    setDlg({
      action,
      approvalId: id,
      scope: scopeOk ? (a.scope as Record<string, unknown>) : {},
      scopeOk,
      scopeDigest: a.scope_digest == null ? null : String(a.scope_digest),
      mission: a.mission_id == null ? null : String(a.mission_id),
      reason: a.reason == null ? null : String(a.reason),
      requested: a.requested_action == null ? null : String(a.requested_action),
    });
  };

  /* Reviews lane — canonical company projection for the selected
     business only (abort + forBiz render guard). */
  useEffect(() => {
    setSt(biz ? { kind: "loading" } : { kind: "no-business" });
    if (!biz) return;
    const ctl = new AbortController();
    api
      .businessCompany(biz, ctl.signal)
      .then((r) => {
        if (!ctl.signal.aborted) setSt({ kind: "ready", data: r.company, forBiz: biz });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => ctl.abort();
  }, [biz, tick]);

  /* Approvals lane — GLOBAL unscoped queue. Independent of biz so a
     denied/missing business never implies an empty global queue. */
  useEffect(() => {
    const ctl = new AbortController();
    setApr({ kind: "loading" });
    api
      .approvalsNoPrompt()
      .then((a) => { if (!ctl.signal.aborted) setApr({ kind: "ready", rows: Array.isArray(a) ? a : [] }); })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setApr({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => ctl.abort();
  }, [tick]);

  const decide = () => {
    if (!dlg || !dlg.scopeOk) return;
    const { action, approvalId, scope } = dlg;
    const seq = ++opSeq.current;
    setDlg(null);
    setMutBusy(true);
    setMutNote(null);
    (action === "approve" ? api.approveNoPrompt(approvalId, scope) : api.denyNoPrompt(approvalId, scope))
      .then(() => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        setMutNote(`${action} committed on ${approvalId.slice(0, 18)} — global queue refetched.`);
        setTick((n) => n + 1);
        invalidateInboxCounts(); // R1-F1 — badge refetches canonical too
      })
      .catch((e: unknown) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        setMutNote(`${action} failed: ${e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e)}`);
      });
  };

  const acceptReview = () => {
    if (!rdlg) return;
    const { objectiveId, reviewId } = rdlg;
    const seq = ++opSeq.current;
    setRdlg(null);
    setMutBusy(true);
    setMutNote(null);
    api
      .objectiveReviewSignoff(objectiveId, {
        review_id: reviewId,
        idempotency_key: crypto.randomUUID(),
      })
      .then((r) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        setMutNote(
          r.signoff.replayed
            ? `ACHIEVED already committed on ${objectiveId.slice(0, 18)} (idempotent replay).`
            : `ACHIEVED committed on ${objectiveId.slice(0, 18)} — objective finalized.`,
        );
        setTick((n) => n + 1);
        invalidateInboxCounts();
      })
      .catch((e: unknown) => {
        if (seq !== opSeq.current) return;
        setMutBusy(false);
        setMutNote(`accept failed: ${e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e)}`);
      });
  };

  /* Synchronous render guards — never paint stale-for-this-biz data. */
  const companyReady =
    st.kind === "ready" && st.forBiz === biz && String(st.data.business.business_id) === biz;
  const pendingRows = companyReady
    ? st.data.objectives.filter((o) => o.latest_review?.owner_action_required && !TERMINAL.has(o.status))
    : [];
  const reviewsExact = companyReady ? st.data.counts.targets_met_pending : null;
  const truncated = companyReady && st.data.objectives_truncated;
  const pendingApprovals = apr.kind === "ready" ? apr.rows.filter((a) => a.status === "PENDING") : null;

  const show = (lane: Exclude<Filter, "all">) => filter === "all" || filter === lane;

  return (
    <>
      <div className="chead">
        <div>
          <h1>Owner Inbox</h1>
          <div className="sub">Reviews sign-off · global approvals · policy halts</div>
        </div>
      </div>

      <div className="ftabs" role="tablist" aria-label="inbox lanes">
        {(["all", "approval", "review", "halt"] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            className={`ftab${filter === f ? " on" : ""}`}
            onClick={() => setSp(f === "all" ? {} : { lane: f })}
          >
            {f}
            <span className="c">
              {f === "review" ? (reviewsExact === null ? "?" : reviewsExact)
                : f === "approval" ? (pendingApprovals === null ? "?" : pendingApprovals.length)
                : f === "halt" ? "—" : ""}
            </span>
          </button>
        ))}
      </div>

      {mutNote ? <div className="trunc" role="status">{mutNote}</div> : null}

      {show("review") ? (
        <>
          <h2 className="sech">Reviews pending your sign-off</h2>
          {!biz ? (
            <EmptyState title="No business selected" detail="Select a business to see its objective reviews — access is proven on read." />
          ) : st.kind === "loading" || (st.kind === "ready" && !companyReady) ? (
            <div className="need">{[0, 1].map((i) => <div className="nrow" key={i}><Skeleton height={12} width="60%" /></div>)}</div>
          ) : st.kind === "error" ? (
            st.err.status === 403 ? (
              <DeniedState detail={`Reviews unavailable — ${st.err.detail || "no access to this business"} (${st.err.code}). The global approvals lane below is unaffected.`} />
            ) : (
              <ErrorState code={st.err.code} detail={st.err.detail} onRetry={() => setTick((n) => n + 1)} />
            )
          ) : (
            <>
              <div className="sub">
                {reviewsExact} pending exact across all owned objectives
                {truncated ? ` — list shows ${pendingRows.length} of ${st.data.objectives.length} returned (partial)` : ""}
              </div>
              <div className="need">
                {pendingRows.length === 0 ? (
                  <div className="nrow"><span className="note">
                    {reviewsExact === 0
                      ? "Nothing pending — fresh pin check is clean."
                      : `${reviewsExact} pending outside the shown rows — list truncated.`}
                  </span></div>
                ) : null}
                {pendingRows.map((o) => (
                  <div className="nrow" key={o.objective_id}>
                    <span className="tt">{o.title || o.objective_id}</span>
                    <StatusBadge tone="warn" label={o.status} />
                    <span className="note">
                      {o.latest_review?.outcome ?? "—"}
                      {o.latest_review?.recommended_status ? ` → ${o.latest_review.recommended_status}` : ""}
                      {" · fresh pin ◐"}
                    </span>
                    <Link className="go" to={`/app/objectives/${encodeURIComponent(o.objective_id)}`}>open objective →</Link>
                    <span className="note">
                      <button className="ghost" disabled={mutBusy || !o.latest_review?.review_id}
                        title={o.latest_review?.review_id ? undefined : "no canonical review pinned"}
                        onClick={() => setRdlg({
                          objectiveId: o.objective_id,
                          title: o.title || o.objective_id,
                          reviewId: String(o.latest_review!.review_id),
                          outcome: String(o.latest_review!.outcome ?? "—"),
                          recommended: o.latest_review!.recommended_status ?? null,
                        })}>Accept ACHIEVED (A2)</button>
                      <button className="ghost" disabled title="API_MISSING — owner feedback seam not built yet">Request changes (A2)</button>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : null}

      {show("approval") ? (
        <>
          <h2 className="sech">Approvals — global queue <span className="note">(not scoped to the selected business)</span></h2>
          {apr.kind === "loading" ? (
            <div className="need">{[0, 1].map((i) => <div className="nrow" key={i}><Skeleton height={12} width="60%" /></div>)}</div>
          ) : apr.kind === "error" ? (
            apr.err.status === 401 ? (
              <ErrorState code={apr.err.code || "UNAUTHORIZED"} detail="Your credentials were rejected — update the session token and retry." onRetry={() => setTick((n) => n + 1)} />
            ) : apr.err.status === 403 ? (
              <DeniedState detail={`Approvals denied: ${apr.err.detail} (${apr.err.code})`} />
            ) : (
              <ErrorState code={apr.err.code} detail={apr.err.detail} onRetry={() => setTick((n) => n + 1)} />
            )
          ) : (
            <div className="need">
              {pendingApprovals!.length === 0 ? <div className="nrow"><span className="note">No pending approvals in the global queue.</span></div> : null}
              {pendingApprovals!.map((a) => {
                const id = String(a.approval_id ?? a.entity_id);
                return (
                  <div className="nrow" key={id}>
                    <span className="tt">{id.slice(0, 18)}</span>
                    <span className="note">
                      mission {String(a.mission_id ?? "—").slice(0, 18)} · {String(a.reason ?? a.approval_type ?? a.kind ?? "—")}
                      {a.requested_action ? ` · asks ${String(a.requested_action)}` : ""}
                    </span>
                    <StatusBadge tone="warn" label={String(a.status)} />
                    <span className="note">
                      <button className="ghost" disabled={mutBusy}
                        onClick={() => openDecide(a, "approve")}>Approve</button>
                      <button className="ghost" disabled={mutBusy}
                        onClick={() => openDecide(a, "deny")}>Deny</button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : null}

      {show("halt") ? (
        <>
          <h2 className="sech">HALT / auto policy</h2>
          <div className="need">
            <div className="nrow">
              <span className="note">
                HALT aggregation unavailable — API_MISSING. No canonical enumeration endpoint exists;
                per-objective policy state lives on Objective Detail.
              </span>
              <Link className="go" to="/app/objectives">open objectives →</Link>
            </div>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={dlg !== null}
        title={dlg?.action === "approve" ? "Approve request" : "Deny request"}
        body={dlg?.scopeOk
          ? `${dlg.action === "approve" ? "Approve" : "Deny"} ${dlg.approvalId.slice(0, 18)}? This commits the existing canonical ${dlg.action} mutation on the GLOBAL queue with the pinned scope shown below — backend scope_digest checking remains authoritative.`
          : "Canonical scope missing or malformed — fail closed."}
        confirmLabel={dlg?.action === "approve" ? "Approve" : "Deny"}
        busy={mutBusy}
        confirmDisabled={dlg !== null && !dlg.scopeOk}
        onConfirm={decide}
        onCancel={() => setDlg(null)}
      >
        {dlg ? (
          <>
            <dl className="dmeta">
              <dt>approval</dt><dd><code>{dlg.approvalId}</code></dd>
              <dt>action</dt><dd>{dlg.action}{dlg.requested ? ` · requests ${dlg.requested}` : ""}</dd>
              <dt>mission</dt><dd><code>{dlg.mission ?? "—"}</code></dd>
              <dt>reason</dt><dd>{dlg.reason ?? "—"}</dd>
              <dt>scope</dt><dd>
                {dlg.scopeOk
                  ? <code aria-label="pinned approval scope">{JSON.stringify(dlg.scope)}</code>
                  : <span className="warn">MISSING / MALFORMED — not substituted</span>}
                {dlg.scopeDigest ? <span className="note"> · digest <code>{dlg.scopeDigest.slice(0, 16)}</code></span> : null}
              </dd>
            </dl>
            {!dlg.scopeOk ? (
              <p className="warn" role="alert">
                This row carries no canonical scope object — approving or denying it is not safe.
                Refresh the global queue; if it persists the backend data is malformed.
              </p>
            ) : null}
          </>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={rdlg !== null}
        title="Accept ACHIEVED"
        body="Finalize this objective as ACHIEVED? This commits the existing canonical owner sign-off against the pinned review below — backend re-checks freshness, latest-review and active-work invariants and remains authoritative."
        confirmLabel="Accept ACHIEVED"
        busy={mutBusy}
        onConfirm={acceptReview}
        onCancel={() => setRdlg(null)}
      >
        {rdlg ? (
          <dl className="dmeta">
            <dt>objective</dt><dd><code>{rdlg.objectiveId}</code></dd>
            <dt>title</dt><dd>{rdlg.title}</dd>
            <dt>review</dt><dd><code>{rdlg.reviewId}</code></dd>
            <dt>outcome</dt><dd>{rdlg.outcome}{rdlg.recommended ? ` → ${rdlg.recommended}` : ""}</dd>
          </dl>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
