import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiAdmin, ApiError } from "../../api";
import type {
  AutoDriverStatus,
  AutoSchedulerStatus,
  ObjectiveOperations,
  ObjectiveRelation,
  OrgAgentDuty,
} from "../../types";
import { fmtDue, fmtTs, shouldApplyResponse } from "../lib/objectiveLoop";
import { StatusBadge, type Tone } from "./StatusBadge";
import { DeniedState, ErrorState, Skeleton } from "./states";

/* P18.1 — per-objective operations monitor. Reads ONLY
   GET /api/vnext/objectives/:id/operations — the one-call aggregate of
   the canonical objective row plus the same owner-scoped
   policy/scheduler/driver/admission/duty reads the detail page already
   polls. 5s cadence, abort/newest-wins: every poll aborts the in-flight
   request and atMs guards out-of-order landings, so a stale response
   can never overwrite a fresher one. Every cell is an observed field —
   null sections render NOT_OBSERVED, never inferred progress or
   synthetic ETAs. Subsections are labeled by source: CANONICAL rows are
   canonical-store reads; DRIVER-STATE rows are runtime observability. */

type St =
  | { kind: "loading" }
  | { kind: "ready"; data: ObjectiveOperations; forId: string; atMs: number }
  | { kind: "error"; err: ApiError };

const S_TONE: Record<string, Tone> = {
  DRAFT: "unknown", PROPOSED: "info", RUNNING: "info", PAUSED: "warn",
  ACHIEVED: "ok", CANCELLED: "unknown", FAILED: "danger", EXPIRED: "warn",
  ACTIVE: "ok", BLOCKED: "danger", INFEASIBLE: "danger",
  ENABLED: "ok", DISABLED: "unknown", PAUSED_P: "warn", HALTED: "danger",
  REVOKED: "danger", EXPIRED_P: "warn",
};

/* Queue-state tones — only observed states; unknown values fall back to
   "unknown" with the raw label rendered verbatim. */
const Q_TONE: Record<string, Tone> = {
  WAITING_CONSUMER: "warn", WAITING_EVIDENCE: "warn", WAITING: "warn", IDLE: "warn",
  CLAIMED: "info", EXECUTING: "info", IN_PROGRESS: "info",
  BLOCKED_AUTHORITY: "danger", BLOCKED_RETRY_EXHAUSTED: "danger",
  QUARANTINED: "danger", UNREGISTERED: "unknown",
};

const LEASE_TONE: Record<string, Tone> = {
  ACTIVE: "info", CLAIMED: "info", HELD: "info",
  EXPIRED: "warn", RELEASED: "unknown", SETTLED: "unknown", INVALIDATED: "danger",
};

const OUTCOME_TONE: Record<string, Tone> = {
  FAULT: "danger", CEO_PASS_COMMITTED: "ok", PASS_COMMITTED: "ok", COMMITTED: "ok",
};

/* Relative duration for lease expiry / countdown display — observational
   text only, never a claim of server-side truth. */
function fmtRel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function leaseLine(l: { state: string; fence: number | null; expires_at: number | null }, nowMs: number): string {
  const base = `fence ${l.fence ?? "—"}`;
  if (l.expires_at === null || l.expires_at === undefined || !Number.isFinite(l.expires_at))
    return `${base} · no expiry observed`;
  return l.expires_at > nowMs
    ? `${base} · expires in ${fmtRel(l.expires_at - nowMs)}`
    : `${base} · expired ${fmtRel(nowMs - l.expires_at)} ago`;
}

function objLink(id: string) {
  return (
    <Link
      to={`/app/objectives/${encodeURIComponent(id)}`}
      title={id}
      style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
    >
      {id.slice(0, 16)}…
    </Link>
  );
}

function countBy<T>(rows: T[], key: (r: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function SchedulerBlock(props: { s: AutoSchedulerStatus; nowMs: number }) {
  const { s, nowMs } = props;
  return (
    <>
      <div className="nrow">
        <span className="tt">queue_state</span>
        <StatusBadge tone={Q_TONE[s.queue_state] ?? "unknown"} label={s.queue_state || "NOT_OBSERVED"} />
        {s.owner_action_required ? <StatusBadge tone="warn" label="⚠ owner action required" /> : null}
      </div>
      <div className="nrow">
        <span className="tt">generation</span>
        <span className="note">
          pending {s.pending_generation ?? "—"} → claimed {s.claimed_generation ?? "—"}
          {s.coalesced_count != null ? ` · coalesced ${s.coalesced_count}` : ""}
        </span>
      </div>
      <div className="nrow">
        <span className="tt">next_due</span>
        <span className="note">{fmtDue(s.next_due, nowMs)}</span>
      </div>
      {s.wait_kind || s.retry_count || s.catchup_state ? (
        <div className="nrow">
          <span className="tt">wait / retry</span>
          <span className="note">
            wait_kind {s.wait_kind ?? "—"} · retry_count {s.retry_count}
            {s.catchup_state ? ` · catchup ${s.catchup_state}` : ""}
          </span>
        </div>
      ) : null}
      {s.blocked_reason ? (
        <div className="nrow">
          <span className="tt">blocked_reason</span>
          <StatusBadge tone="warn" label={s.blocked_reason} />
        </div>
      ) : null}
      {Array.isArray(s.pending_reasons) && s.pending_reasons.length > 0 ? (
        <div className="nrow">
          <span className="tt">pending_reasons</span>
          <span className="note">{s.pending_reasons.join(", ")}</span>
        </div>
      ) : null}
      <div className="nrow">
        <span className="tt">lease</span>
        {s.lease ? (
          <>
            <StatusBadge tone={LEASE_TONE[s.lease.state] ?? "unknown"} label={s.lease.state} />
            <span className="note">{leaseLine(s.lease, nowMs)}</span>
          </>
        ) : (
          <span className="note">no lease observed</span>
        )}
      </div>
    </>
  );
}

function DriverBlock(props: { d: AutoDriverStatus; nowMs: number }) {
  const { d, nowMs } = props;
  const admissions = Array.isArray(d.admissions) ? d.admissions.slice(-8).reverse() : [];
  const denials = Array.isArray(d.denials) ? d.denials.slice(-8) : [];
  const gap = d.capability_gap ?? null;
  return (
    <>
      <div className="nrow">
        <span className="tt">enabled</span>
        <StatusBadge tone={d.enabled ? "info" : "unknown"} label={String(d.enabled)} />
        <span className="tt">last_outcome</span>
        {d.last_outcome ? (
          <StatusBadge tone={OUTCOME_TONE[d.last_outcome] ?? "unknown"} label={d.last_outcome} />
        ) : (
          <span className="note">none observed</span>
        )}
        {d.last_result?.fault ? <StatusBadge tone="danger" label={`fault ${d.last_result.fault}`} /> : null}
      </div>
      {d.last_fence !== null && d.last_fence !== undefined ? (
        <div className="nrow">
          <span className="tt">last_fence</span>
          <span className="note">{d.last_fence}</span>
        </div>
      ) : null}
      {gap ? (
        gap.state === "OPEN" ? (
          <div className="nrow">
            <span className="tt">capability gap</span>
            <StatusBadge tone={gap.permanence === "transient" ? "warn" : "danger"} label={String(gap.gap_kind ?? gap.label ?? "OPEN")} />
            <span className="note">
              {String(gap.label ?? "")}{gap.permanence ? ` · ${gap.permanence}` : ""}
              {gap.occurrences != null && Number(gap.occurrences) > 1 ? ` · ×${Number(gap.occurrences)}` : ""}
              {gap.opened_at ? ` · since ${String(gap.opened_at).slice(0, 16).replace("T", " ")}` : ""}
            </span>
            {gap.owner_action ? <span className="note">{String(gap.owner_action)}</span> : null}
          </div>
        ) : gap.state === "UNVERIFIED" ? (
          <div className="nrow">
            <span className="tt">capability gap</span>
            <StatusBadge tone="warn" label="UNVERIFIED" />
            <span className="note">canonical gap row failed re-proof — advisory hidden, never trusted</span>
          </div>
        ) : (
          <div className="nrow">
            <span className="tt">capability gap</span>
            <StatusBadge tone="unknown" label={String(gap.state)} />
            <span className="note">{gap.resolved_at ? `resolved ${String(gap.resolved_at).slice(0, 16).replace("T", " ")}` : "not open"}</span>
          </div>
        )
      ) : (
        <div className="nrow">
          <span className="tt">capability gap</span>
          <span className="note">no gap</span>
        </div>
      )}
      <div className="nrow">
        <span className="tt">lease</span>
        {d.lease ? (
          <>
            <StatusBadge tone={LEASE_TONE[d.lease.state] ?? "unknown"} label={d.lease.state} />
            <span className="note">{leaseLine(d.lease, nowMs)}</span>
          </>
        ) : (
          <span className="note">no lease observed</span>
        )}
      </div>
      {admissions.length ? (
        <>
          <div className="nrow"><span className="tt">admissions</span><span className="note">last {admissions.length} — fence · generation · at · usage</span></div>
          {admissions.map((a, i) => (
            <div className="nrow" key={`adm-${i}`}>
              <span className="note">
                fence {a.fence ?? "—"} · gen {a.generation ?? "—"} · {fmtTs(a.at)}
                {a.usage ? ` · ceo ${a.usage.ceo_calls ?? "—"} · missions ${a.usage.missions ?? "—"} · μusd ${a.usage.microusd ?? "—"}` : ""}
              </span>
            </div>
          ))}
        </>
      ) : null}
      {denials.length ? (
        <>
          <div className="nrow"><span className="tt">denials</span><span className="note">last {denials.length} — historical records</span></div>
          {denials.map((dn, i) => (
            <div className="nrow" key={`den-${i}`}>
              <span className="note">
                {fmtTs(dn?.at ?? null)} · fence {dn?.fence ?? "—"} · {dn?.label ?? "—"}
              </span>
            </div>
          ))}
        </>
      ) : (
        <div className="nrow"><span className="note">no denials recorded</span></div>
      )}
    </>
  );
}

export function ObjectiveOpsMonitor(props: { objectiveId: string }): JSX.Element {
  const { objectiveId } = props;
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastApplied = useRef(0);

  /* Cross-objective isolation: a new id drops the old snapshot and its
     applied-watermark — foreign data can never render under this route. */
  useEffect(() => {
    lastApplied.current = 0;
    setSt({ kind: "loading" });
  }, [objectiveId]);

  useEffect(() => {
    if (!objectiveId) return;
    /* Silent re-poll: keep the last good snapshot for THIS id while the
       refetch is in flight — never collapse to the skeleton per tick. */
    setSt((prev) => (prev.kind === "ready" && prev.forId === objectiveId ? prev : { kind: "loading" }));
    const ctl = new AbortController();
    apiAdmin
      .objectiveOperationsApp(objectiveId, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const atMs = Date.now();
        const ops = r?.operations;
        if (!ops || String(ops.objective_id) !== objectiveId) {
          lastApplied.current = atMs;
          setSt({ kind: "error", err: new ApiError(0, "IDENTITY_MISMATCH", "operations response identity does not match this objective.") });
          return;
        }
        if (!shouldApplyResponse(lastApplied.current, atMs)) return;
        lastApplied.current = atMs;
        setSt({ kind: "ready", data: ops, forId: objectiveId, atMs });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => ctl.abort();
  }, [objectiveId, tick]);

  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") {
        setTick((n) => n + 1);
        setNowMs(Date.now());
      }
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  const refetch = () => setTick((n) => n + 1);

  if (st.kind === "loading") {
    return (
      <section aria-label="Operations monitor">
        <h2 className="sech">Operations monitor</h2>
        <div className="sub">Loading operations for {objectiveId}…</div>
        <Skeleton height={14} width="40%" />
        <Skeleton height={120} />
      </section>
    );
  }
  if (st.kind === "error") {
    const { err } = st;
    return (
      <section aria-label="Operations monitor">
        <h2 className="sech">Operations monitor</h2>
        {err.status === 403 ? (
          <DeniedState detail={`${err.detail || "Owner authority is required for this objective's operations."} (${err.code})`} />
        ) : (
          <ErrorState
            code={err.code || "ERROR"}
            detail={err.status === 401
              ? `Your credentials were rejected — update the session token and retry. ${err.detail}`
              : err.code.startsWith("FAIL_CLOSED")
                ? `Integrity check failed — possibly-corrupt data was not rendered. ${err.detail}`
                : err.detail || "The operations read failed."}
            onRetry={refetch}
          />
        )}
      </section>
    );
  }

  /* Synchronous identity guard — never paint a snapshot that belongs to
     another objective id. */
  if (st.forId !== objectiveId || String(st.data.objective_id) !== objectiveId) {
    return (
      <section aria-label="Operations monitor">
        <h2 className="sech">Operations monitor</h2>
        <div className="sub">Loading operations for {objectiveId}…</div>
        <Skeleton height={120} />
      </section>
    );
  }

  const ops = st.data;
  const o = ops.objective ?? ({} as ObjectiveOperations["objective"]);
  const status = String(o.status ?? "NOT_OBSERVED");
  const updatedAt = typeof o.updated_at === "string" ? o.updated_at : null;
  const s = ops.auto_scheduler;
  const d = ops.auto_driver;
  const p = ops.auto_policy;
  const admission = ops.admission ?? { upstream: [], conflicts: [], superseded_by: [] };
  const upstream = Array.isArray(admission.upstream) ? admission.upstream : [];
  const conflicts = Array.isArray(admission.conflicts) ? admission.conflicts : [];
  const supersededBy = Array.isArray(admission.superseded_by) ? admission.superseded_by : [];
  const relations: ObjectiveRelation[] = Array.isArray(ops.relations) ? ops.relations : [];
  const duties: OrgAgentDuty[] = Array.isArray(ops.duties) ? ops.duties : [];
  const age = Math.max(0, Math.round((nowMs - st.atMs) / 1000));

  return (
    <section aria-label="Operations monitor">
      <h2 className="sech">Operations monitor</h2>
      <div className="sub" style={{ marginBottom: 8 }}>
        <StatusBadge tone={S_TONE[status] ?? "unknown"} label={status} />{" "}
        {o.title ? `${String(o.title)} · ` : ""}{objectiveId}
        {updatedAt ? ` · updated ${String(updatedAt).slice(0, 19).replace("T", " ")}` : " · updated_at not reported"}
        {" · observed "}{age}s ago{" · "}
        <button className="tbtn" onClick={refetch}>refresh</button>
      </div>

      <div className="grid2">
        <div className="need">
          <div className="h">Scheduler <StatusBadge tone="unknown" label="DRIVER-STATE" title="Scheduler runtime observability — not a canonical lifecycle read" /></div>
          {s === null || s === undefined ? (
            <div className="nrow"><span className="note">scheduler not deployed — NOT_OBSERVED</span></div>
          ) : (
            <SchedulerBlock s={s} nowMs={nowMs} />
          )}
        </div>

        <div className="need">
          <div className="h">Driver <StatusBadge tone="unknown" label="DRIVER-STATE" title="Driver runtime observability — durable driver record, not canonical lifecycle" /></div>
          {d === null || d === undefined ? (
            <div className="nrow"><span className="note">driver not deployed — NOT_OBSERVED</span></div>
          ) : (
            <DriverBlock d={d} nowMs={nowMs} />
          )}
        </div>
      </div>

      <div className="grid2">
        <div className="need">
          <div className="h">Admission gates <StatusBadge tone="info" label="CANONICAL" title="Canonical relation-service admission view" /></div>
          {upstream.length === 0 && conflicts.length === 0 && supersededBy.length === 0 ? (
            <div className="nrow"><span className="note">no gates</span></div>
          ) : null}
          {upstream.length ? (
            <div className="nrow">
              <span className="tt">upstream</span>
              {upstream.map((id) => <span key={id}>{objLink(String(id))}</span>)}
              <span className="note">must be satisfied before admission</span>
            </div>
          ) : null}
          {conflicts.length ? (
            <div className="nrow">
              <span className="tt">conflicts</span>
              {conflicts.map((id) => <span key={id}>{objLink(String(id))}</span>)}
              <span className="note">mutual exclusion — an active lease on one blocks the other</span>
            </div>
          ) : null}
          {supersededBy.length ? (
            <div className="nrow">
              <span className="tt">superseded_by</span>
              {supersededBy.map((id) => <span key={id}>{objLink(String(id))}</span>)}
              <span className="note">this objective is superseded</span>
            </div>
          ) : null}

          <div className="h" style={{ borderTop: "1px solid var(--border)" }}>Policy <StatusBadge tone="info" label="CANONICAL" /></div>
          {p === null || p === undefined ? (
            <div className="nrow"><span className="note">no policy</span></div>
          ) : !p.configured ? (
            <div className="nrow"><span className="note">not configured — owner must enable before the driver may act</span></div>
          ) : (
            <>
              <div className="nrow">
                <span className="tt">state</span>
                <StatusBadge tone={S_TONE[String(p.state)] ?? "unknown"} label={String(p.state)} />
                <span className="note">
                  effective {String(p.effective)} · v{p.policy_version ?? "—"}
                  {p.expires_at ? ` · expires ${String(p.expires_at).slice(0, 16).replace("T", " ")}` : ""}
                </span>
              </div>
              {p.halt ? (
                <div className="nrow">
                  <span className="tt">halt</span>
                  <StatusBadge tone="danger" label={p.halt.scope} />
                  <span className="note">{p.halt.reason} · {p.halt.actor} · {String(p.halt.at).slice(0, 16).replace("T", " ")}</span>
                </div>
              ) : null}
              {Array.isArray(p.reasons) && p.reasons.length ? (
                <div className="nrow"><span className="tt">reasons</span><span className="note">{p.reasons.join(", ")}</span></div>
              ) : null}
            </>
          )}
        </div>

        <div className="need">
          <div className="h">Relations & duties <StatusBadge tone="info" label="CANONICAL" /></div>
          {relations.length === 0 && duties.length === 0 ? (
            <div className="nrow"><span className="note">no relations or duties recorded</span></div>
          ) : null}
          {relations.length ? (
            <div className="nrow">
              <span className="tt">relations</span>
              <span className="note">
                {countBy(relations, (r) => String(r.kind)).map(([k, n]) => `${k} ×${n}`).join(" · ")}
                {" — "}
                {countBy(relations, (r) => String(r.state)).map(([k, n]) => `${k} ×${n}`).join(" · ")}
              </span>
            </div>
          ) : null}
          {duties.length ? (
            <div className="nrow">
              <span className="tt">duties</span>
              <span className="note">
                {countBy(duties, (x) => String(x.state)).map(([k, n]) => `${k} ×${n}`).join(" · ")}
                {" · agents "}
                {countBy(duties, (x) => String(x.org_agent_id)).map(([k]) => k.slice(0, 12)).join(", ")}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
