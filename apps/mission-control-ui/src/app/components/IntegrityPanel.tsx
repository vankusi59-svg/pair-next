import { useEffect, useRef, useState } from "react";
import { apiAdmin, ApiError } from "../../api";
import type { IntegrityProbe } from "../../types";
import { shouldApplyResponse } from "../lib/objectiveLoop";
import { StatusBadge } from "./StatusBadge";
import { DeniedState, ErrorState, Skeleton } from "./states";

/* P18.1 — integrity observability panel. Reads ONLY
   GET /api/vnext/objectives/:id/integrity — the read-only probe that
   re-runs the canonical strict reads an admission gate depends on and
   reports CLEAN / WEDGED. 15s cadence plus manual refresh;
   abort/newest-wins like every owner read. The probe NEVER repairs —
   a wedge is surfaced verbatim with its typed code and remediation
   text, and the panel states explicitly that no automatic repair
   exists. */

type St =
  | { kind: "loading" }
  | { kind: "ready"; data: IntegrityProbe; forId: string; atMs: number }
  | { kind: "error"; err: ApiError };

export function IntegrityPanel(props: { objectiveId: string }): JSX.Element {
  const { objectiveId } = props;
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastApplied = useRef(0);

  useEffect(() => {
    lastApplied.current = 0;
    setSt({ kind: "loading" });
  }, [objectiveId]);

  useEffect(() => {
    if (!objectiveId) return;
    /* Silent re-poll: keep the last good probe for THIS id in flight. */
    setSt((prev) => (prev.kind === "ready" && prev.forId === objectiveId ? prev : { kind: "loading" }));
    const ctl = new AbortController();
    apiAdmin
      .objectiveIntegrityApp(objectiveId, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const atMs = Date.now();
        /* Fail-closed identity: a probe naming another objective is an
           error surface, never data for this panel. */
        if (!r || String(r.objective_id) !== objectiveId) {
          lastApplied.current = atMs;
          setSt({ kind: "error", err: new ApiError(0, "IDENTITY_MISMATCH", "integrity probe response identity does not match this objective.") });
          return;
        }
        if (!shouldApplyResponse(lastApplied.current, atMs)) return;
        lastApplied.current = atMs;
        setSt({ kind: "ready", data: r, forId: objectiveId, atMs });
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
    }, 15000);
    return () => clearInterval(iv);
  }, []);

  const refetch = () => setTick((n) => n + 1);

  if (st.kind === "loading") {
    return (
      <section aria-label="Integrity">
        <h2 className="sech">Integrity</h2>
        <div className="sub">Probing canonical strict reads for {objectiveId}…</div>
        <Skeleton height={40} />
      </section>
    );
  }
  if (st.kind === "error") {
    const { err } = st;
    return (
      <section aria-label="Integrity">
        <h2 className="sech">Integrity</h2>
        {err.status === 403 ? (
          <DeniedState detail={`${err.detail || "Owner authority is required for this integrity probe."} (${err.code})`} />
        ) : (
          <ErrorState
            code={err.code || "ERROR"}
            detail={err.status === 401
              ? `Your credentials were rejected — update the session token and retry. ${err.detail}`
              : err.code.startsWith("FAIL_CLOSED")
                ? `Integrity check failed — possibly-corrupt data was not rendered. ${err.detail}`
                : err.detail || "The integrity probe failed — integrity is unverified, not assumed clean."}
            onRetry={refetch}
          />
        )}
      </section>
    );
  }
  if (st.forId !== objectiveId || String(st.data.objective_id) !== objectiveId) {
    return (
      <section aria-label="Integrity">
        <h2 className="sech">Integrity</h2>
        <div className="sub">Probing canonical strict reads for {objectiveId}…</div>
        <Skeleton height={40} />
      </section>
    );
  }

  const probe = st.data;
  const checks = Array.isArray(probe.checks) ? probe.checks : [];
  const failed = checks.filter((c) => c.ok !== true);
  const wedged = probe.status === "WEDGED" || failed.length > 0;
  const clean = probe.status === "CLEAN" && failed.length === 0;
  const age = Math.max(0, Math.round((nowMs - st.atMs) / 1000));

  return (
    <section aria-label="Integrity">
      <h2 className="sech">Integrity</h2>
      <div className="sub" style={{ marginBottom: 8 }}>
        probe status{" "}
        <StatusBadge
          tone={clean ? "ok" : wedged ? "danger" : "unknown"}
          label={probe.status || "NOT_OBSERVED"}
        />
        {" · observed "}{age}s ago{" · "}
        <button className="tbtn" onClick={refetch}>refresh</button>
      </div>

      {clean ? (
        <div className="need">
          <div className="nrow">
            <StatusBadge tone="ok" label="CLEAN" />
            <span className="note">canonical integrity: all checks pass</span>
          </div>
          <div className="nrow">
            <details>
              <summary className="note" style={{ cursor: "pointer" }}>
                {checks.length} check{checks.length === 1 ? "" : "s"} run — names only, no data claims
              </summary>
              <div style={{ padding: "6px 0 2px" }}>
                {checks.map((c, i) => (
                  <div key={`chk-${i}`} className="note" style={{ padding: "2px 0" }}>
                    {String(c.name)} — {c.ok ? "ok" : "failed"}
                  </div>
                ))}
              </div>
            </details>
          </div>
        </div>
      ) : wedged ? (
        <>
          <div
            role="alert"
            style={{
              border: "1px solid var(--danger)",
              background: "var(--danger-soft)",
              borderRadius: 8,
              padding: "10px 12px",
              margin: "8px 0",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <StatusBadge tone="danger" label="WEDGED" />
              <strong style={{ fontSize: 13 }}>
                canonical integrity wedged — a strict read failed closed
              </strong>
            </div>
            {failed.map((c, i) => (
              <div key={`fail-${i}`} style={{ fontSize: 12, padding: "3px 0" }}>
                <span style={{ fontWeight: 650 }}>{String(c.name)}</span>
                {c.code ? (
                  <>
                    {" · "}
                    <StatusBadge tone="danger" label={String(c.code)} />
                  </>
                ) : null}
                {c.detail ? <div className="note" style={{ color: "var(--text-2)" }}>{String(c.detail)}</div> : null}
              </div>
            ))}
            {probe.remediation ? (
              <div style={{ fontSize: 12, marginTop: 8 }}>{probe.remediation}</div>
            ) : null}
            <div style={{ fontSize: 12, marginTop: 6, fontWeight: 650 }}>
              no automatic repair — see runbook
            </div>
          </div>
          {checks.length > failed.length ? (
            <div className="need">
              <div className="nrow">
                <details>
                  <summary className="note" style={{ cursor: "pointer" }}>
                    {checks.length - failed.length} check{checks.length - failed.length === 1 ? "" : "s"} still pass
                  </summary>
                  <div style={{ padding: "6px 0 2px" }}>
                    {checks.filter((c) => c.ok === true).map((c, i) => (
                      <div key={`ok-${i}`} className="note" style={{ padding: "2px 0" }}>
                        {String(c.name)} — ok
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="need">
          <div className="nrow">
            <StatusBadge tone="unknown" label={probe.status || "NOT_OBSERVED"} />
            <span className="note">unrecognized probe status — rendered verbatim, not interpreted</span>
          </div>
          {checks.map((c, i) => (
            <div className="nrow" key={`chk-${i}`}>
              <span className="tt">{String(c.name)}</span>
              <StatusBadge tone={c.ok ? "ok" : "danger"} label={c.ok ? "ok" : "failed"} />
              {c.code ? <span className="note">{String(c.code)}</span> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
