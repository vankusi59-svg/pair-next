import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiAdmin, ApiError } from "../../api";
import type { BusinessOperationsRow } from "../../types";
import { fmtDue, shouldApplyResponse } from "../lib/objectiveLoop";
import { StatusBadge, type Tone } from "./StatusBadge";
import { DeniedState, EmptyState, ErrorState, Skeleton } from "./states";

/* P18.1 — company-wide operations table for the Company page. Reads
   ONLY GET /api/vnext/businesses/:id/operations — the server's per-
   owned-objective queue snapshot. 8s cadence, abort/newest-wins like
   every other owner read. Each cell is an observed field: the backend
   writes the literal string "NOT_OBSERVED" when a component is not
   deployed, and absent fields render the same — never inferred
   progress, fake ETAs, or implied success. Rows needing owner eyes
   (owner_action_required, BLOCKED-/QUARANTINED queues) sort first. */

type St =
  | { kind: "loading" }
  | { kind: "ready"; data: BusinessOperationsRow[]; forBiz: string; atMs: number }
  | { kind: "error"; err: ApiError };

const TERMINAL_STATUSES = new Set(["ACHIEVED", "INFEASIBLE", "EXPIRED", "CANCELLED"]);

const S_TONE: Record<string, Tone> = {
  DRAFT: "unknown", PROPOSED: "info", RUNNING: "info", PAUSED: "warn",
  ACHIEVED: "ok", CANCELLED: "unknown", FAILED: "danger", EXPIRED: "warn",
  ACTIVE: "ok", BLOCKED: "danger", INFEASIBLE: "danger",
};

const Q_TONE: Record<string, Tone> = {
  WAITING_CONSUMER: "warn", WAITING_EVIDENCE: "warn", WAITING: "warn", IDLE: "warn",
  CLAIMED: "info", EXECUTING: "info", IN_PROGRESS: "info",
  BLOCKED_AUTHORITY: "danger", BLOCKED_RETRY_EXHAUSTED: "danger",
  QUARANTINED: "danger", UNREGISTERED: "unknown", NOT_OBSERVED: "unknown",
};

const LEASE_TONE: Record<string, Tone> = {
  ACTIVE: "info", CLAIMED: "info", HELD: "info",
  EXPIRED: "warn", RELEASED: "unknown", SETTLED: "unknown", INVALIDATED: "danger",
};

function fmtRel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/* Sort groups: 0 needs-owner (owner action / blocked queue) →
   1 waiting → 2 running → 3 unobserved/other → 4 terminal. */
function rank(r: BusinessOperationsRow): number {
  if (TERMINAL_STATUSES.has(String(r.status))) return 4;
  const q = String(r.queue_state ?? "");
  if (r.owner_action_required === true || q.startsWith("BLOCKED") || q === "QUARANTINED") return 0;
  if (q.startsWith("WAITING") || q === "IDLE") return 1;
  if (q === "CLAIMED" || q === "EXECUTING" || q === "IN_PROGRESS") return 2;
  return 3;
}

export function BusinessOperations(props: {
  businessId: string;
  objectives?: Array<{ objective_id: string; title?: string | null }>;
}): JSX.Element {
  const { businessId, objectives } = props;
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastApplied = useRef(0);

  const titles = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of objectives ?? []) {
      if (o.title) m.set(o.objective_id, o.title);
    }
    return m;
  }, [objectives]);

  useEffect(() => {
    lastApplied.current = 0;
    setSt({ kind: "loading" });
  }, [businessId]);

  useEffect(() => {
    if (!businessId) return;
    /* Silent re-poll: keep the last good rows for THIS business while
       the refetch is in flight — no skeleton collapse per tick. */
    setSt((prev) => (prev.kind === "ready" && prev.forBiz === businessId ? prev : { kind: "loading" }));
    const ctl = new AbortController();
    apiAdmin
      .businessOperationsApp(businessId, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const atMs = Date.now();
        if (!shouldApplyResponse(lastApplied.current, atMs)) return;
        lastApplied.current = atMs;
        const rows = Array.isArray(r?.operations) ? r.operations : [];
        setSt({ kind: "ready", data: rows, forBiz: businessId, atMs });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => ctl.abort();
  }, [businessId, tick]);

  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") {
        setTick((n) => n + 1);
        setNowMs(Date.now());
      }
    }, 8000);
    return () => clearInterval(iv);
  }, []);

  const refetch = () => setTick((n) => n + 1);

  if (st.kind === "loading") {
    return (
      <section aria-label="Business operations">
        <h2 className="sech">Operations</h2>
        <div className="sub">Loading operations for {businessId}…</div>
        <Skeleton height={14} width="50%" />
        <Skeleton height={140} />
      </section>
    );
  }
  if (st.kind === "error") {
    const { err } = st;
    return (
      <section aria-label="Business operations">
        <h2 className="sech">Operations</h2>
        {err.status === 403 ? (
          <DeniedState detail={`${err.detail || "You don't have owner authority over objectives in this business."} (${err.code})`} />
        ) : (
          <ErrorState
            code={err.code || "ERROR"}
            detail={err.status === 401
              ? `Your credentials were rejected — update the session token and retry. ${err.detail}`
              : err.code.startsWith("FAIL_CLOSED")
                ? `Integrity check failed — possibly-corrupt data was not rendered. ${err.detail}`
                : err.detail || "The business operations read failed."}
            onRetry={refetch}
          />
        )}
      </section>
    );
  }
  if (st.forBiz !== businessId) {
    return (
      <section aria-label="Business operations">
        <h2 className="sech">Operations</h2>
        <div className="sub">Loading operations for {businessId}…</div>
        <Skeleton height={140} />
      </section>
    );
  }

  const rows = [...st.data].sort(
    (a, b) => rank(a) - rank(b) || String(a.objective_id).localeCompare(String(b.objective_id)),
  );
  const blocked = rows.filter(
    (r) => String(r.queue_state ?? "").startsWith("BLOCKED") || String(r.queue_state) === "QUARANTINED",
  ).length;
  const ownerAction = rows.filter((r) => r.owner_action_required === true).length;
  const age = Math.max(0, Math.round((nowMs - st.atMs) / 1000));

  return (
    <section aria-label="Business operations">
      <h2 className="sech">Operations</h2>
      <div className="sub" style={{ marginBottom: 8 }}>
        {rows.length} objectives · {blocked} blocked · {ownerAction} owner-action required
        {" · observed "}{age}s ago{" · "}
        <button className="tbtn" onClick={refetch}>refresh</button>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title="No operations rows"
          detail="The owner-scoped operations read returned no objectives for this business."
        />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>objective</th>
                <th>status</th>
                <th>policy</th>
                <th>queue</th>
                <th>pending → claimed</th>
                <th>blocked_reason</th>
                <th>lease</th>
                <th>driver last_outcome</th>
                <th>capability gap</th>
                <th>owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const q = String(r.queue_state ?? "");
                const needsYou = r.owner_action_required === true;
                const gap = r.capability_gap ?? null;
                const title = titles.get(String(r.objective_id)) ?? r.title ?? null;
                return (
                  <tr key={String(r.objective_id)}>
                    <td>
                      <Link to={`/app/objectives/${encodeURIComponent(String(r.objective_id))}`}>
                        {title ? String(title) : String(r.objective_id)}
                      </Link>
                      <div className="muted" style={{ fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
                        {String(r.objective_id).slice(0, 16)}…
                      </div>
                    </td>
                    <td><StatusBadge tone={S_TONE[String(r.status)] ?? "unknown"} label={String(r.status ?? "NOT_OBSERVED")} /></td>
                    <td>
                      {r.auto_policy_effective === true ? (
                        <StatusBadge tone="ok" label="effective" />
                      ) : r.auto_policy_effective === false ? (
                        <StatusBadge tone="warn" label="not effective" />
                      ) : (
                        <StatusBadge tone="unknown" label="NOT_OBSERVED" />
                      )}
                    </td>
                    <td>
                      {q ? (
                        <StatusBadge tone={Q_TONE[q] ?? "unknown"} label={q} />
                      ) : (
                        <StatusBadge tone="unknown" label="NOT_OBSERVED" />
                      )}
                      {typeof r.next_due === "number" && Number.isFinite(r.next_due) ? (
                        <div className="muted" style={{ fontSize: 11 }}>{fmtDue(r.next_due, nowMs).replace(/\(.*\)/, "").trim()}</div>
                      ) : null}
                    </td>
                    <td className="mono">
                      {r.pending_generation ?? "—"} → {r.claimed_generation ?? "—"}
                    </td>
                    <td>
                      {r.blocked_reason ? <StatusBadge tone="warn" label={String(r.blocked_reason)} /> : <span className="muted">—</span>}
                    </td>
                    <td>
                      {r.lease ? (
                        <>
                          <StatusBadge tone={LEASE_TONE[r.lease.state] ?? "unknown"} label={r.lease.state} />
                          <div className="muted" style={{ fontSize: 11 }}>
                            fence {r.lease.fence ?? "—"}
                            {typeof r.lease.expires_at === "number" && Number.isFinite(r.lease.expires_at)
                              ? r.lease.expires_at > nowMs
                                ? ` · expires in ${fmtRel(r.lease.expires_at - nowMs)}`
                                : ` · expired ${fmtRel(nowMs - r.lease.expires_at)} ago`
                              : ""}
                          </div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {r.driver_last_outcome && r.driver_last_outcome !== "NOT_OBSERVED" ? (
                        <StatusBadge tone={r.driver_last_outcome === "FAULT" ? "danger" : "info"} label={String(r.driver_last_outcome)} />
                      ) : (
                        <StatusBadge tone="unknown" label="NOT_OBSERVED" />
                      )}
                    </td>
                    <td>
                      {gap && gap.state === "OPEN" ? (
                        <StatusBadge tone="danger" label={String(gap.gap_kind ?? gap.label ?? "OPEN")} title={gap.owner_action ? String(gap.owner_action) : undefined} />
                      ) : gap && gap.state === "UNVERIFIED" ? (
                        <StatusBadge tone="warn" label="UNVERIFIED" title="gap row failed re-proof — advisory hidden" />
                      ) : (
                        <span className="muted">none</span>
                      )}
                    </td>
                    <td>
                      {needsYou ? <StatusBadge tone="warn" label="⚠ owner action" /> : <span className="muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
