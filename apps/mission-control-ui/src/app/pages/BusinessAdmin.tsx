import { useEffect, useRef, useState } from "react";
import { ApiError, apiAdmin } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState, ErrorState, Skeleton } from "../components/states";
import { StatusBadge } from "../components/StatusBadge";
import type { BusinessDetail, BusinessRow, ProjectRow } from "../types";

/* P15.9-B5.2 — Business Administration (legacy UI_HTML Business-tab parity).
   Create business (project_id verified against GET /api/projects), inspect
   a business by id, select it via the canonical BizContext. GET /api/businesses
   is a GLOBAL unfiltered listing — labeled, never "My Businesses". */

type St =
  | { kind: "loading" }
  | {
      kind: "ready";
      projects: ProjectRow[] | null;      /* null = read failed */
      businesses: BusinessRow[] | null;   /* null = read failed */
      detail: BusinessDetail | null;
      detailFor: string | null;
      detailErr: string | null;
      projectsErr: string | null;
      businessesErr: string | null;
    }
  | { kind: "error"; err: ApiError };

type Form = { name: string; project_id: string; description: string; currency: string };
const EMPTY_FORM: Form = { name: "", project_id: "", description: "", currency: "" };

export function BusinessAdmin() {
  const { select } = useSelectedBusiness();
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [inspectId, setInspectId] = useState("");
  const [dlg, setDlg] = useState<Form | null>(null);
  const [mutBusy, setMutBusy] = useState(false);
  const [mutNote, setMutNote] = useState<string | null>(null);
  const [created, setCreated] = useState<BusinessRow | null>(null);
  const opSeq = useRef(0);

  useEffect(() => {
    setSt({ kind: "loading" });
    const ctl = new AbortController();
    (async () => {
      const [projR, bizR] = await Promise.allSettled([
        apiAdmin.projects(ctl.signal),
        apiAdmin.businesses(ctl.signal),
      ]);
      if (ctl.signal.aborted) return;
      const fatal = [projR, bizR].find(
        (r) => r.status === "rejected" && r.reason instanceof ApiError && r.reason.status === 401,
      );
      if (fatal) {
        const e = (fatal as PromiseRejectedResult).reason;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
        return;
      }
      setSt({
        kind: "ready",
        projects: projR.status === "fulfilled" && Array.isArray(projR.value) ? projR.value : null,
        businesses: bizR.status === "fulfilled" && Array.isArray(bizR.value.businesses) ? bizR.value.businesses : null,
        detail: null,
        detailFor: null,
        detailErr: null,
        projectsErr: projR.status === "rejected" ? (projR.reason instanceof ApiError ? projR.reason.code : "ERROR") : null,
        businessesErr: bizR.status === "rejected" ? (bizR.reason instanceof ApiError ? bizR.reason.code : "ERROR") : null,
      });
    })();
    return () => ctl.abort();
  }, [tick]);

  const inspect = async (id: string) => {
    const forId = id.trim();
    if (!forId) return;
    const seq = ++opSeq.current;
    /* F2 — clear the previous detail payload synchronously: a stale
       inspection must never render under a new target id. */
    setSt((s) => (s.kind === "ready" ? { ...s, detailFor: forId, detail: null, detailErr: null } : s));
    try {
      const d = await apiAdmin.businessDetail(forId);
      if (seq !== opSeq.current) return;
      /* verify the returned identity matches the requested id before
         rendering — a mismatched payload is an error, never shown */
      if (!d || String(d?.business?.business_id) !== forId) {
        setSt((s) =>
          s.kind === "ready" && s.detailFor === forId
            ? { ...s, detail: null, detailErr: `identity mismatch — response for a different business discarded` }
            : s,
        );
        return;
      }
      setSt((s) => (s.kind === "ready" && s.detailFor === forId ? { ...s, detail: d, detailErr: null } : s));
    } catch (e) {
      if (seq !== opSeq.current) return;
      setSt((s) =>
        s.kind === "ready" && s.detailFor === forId
          ? { ...s, detail: null, detailErr: e instanceof ApiError ? `${e.detail || e.message} (${e.code})` : String(e) }
          : s,
      );
    }
  };

  const projectKnown =
    st.kind === "ready" && st.projects !== null && st.projects.some((p) => String(p.project_id) === form.project_id.trim());
  const valid = form.name.trim().length > 0 && form.project_id.trim().length > 0 && projectKnown;

  const submit = async () => {
    if (!dlg || mutBusy) return;
    const payload = dlg;
    const seq = ++opSeq.current;
    setMutBusy(true);
    setMutNote(null);
    try {
      const row = await apiAdmin.createBusiness({
        name: payload.name.trim(),
        project_id: payload.project_id.trim(),
        ...(payload.description.trim() ? { description: payload.description.trim() } : {}),
        ...(payload.currency.trim() ? { currency: payload.currency.trim() } : {}),
      });
      if (seq !== opSeq.current) return;
      setCreated(row);
      setMutNote(`Business created — ${row.business_id}`);
      setForm(EMPTY_FORM);
      setTick((t) => t + 1);
    } catch (e) {
      if (seq !== opSeq.current) return;
      if (e instanceof ApiError) {
        setMutNote(
          e.status === 0 || e.status >= 500
            ? `Create business result AMBIGUOUS (${e.code}) — may have committed; check the global list before retrying. No automatic retry.`
            : `Create business failed: ${e.detail || e.message} (${e.code})`,
        );
      } else {
        setMutNote(`Create business result AMBIGUOUS — ${String(e)}. Check the global list before retrying.`);
      }
    } finally {
      if (seq === opSeq.current) setMutBusy(false);
    }
    setDlg(null);
  };

  if (st.kind === "error") return <ErrorState code={st.err.code} detail={st.err.detail} onRetry={() => setTick((t) => t + 1)} />;
  if (st.kind === "loading") {
    return (
      <div className="page">
        <h1>Business Administration</h1>
        <Skeleton height={18} /><Skeleton height={120} /><Skeleton height={200} />
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Business Administration</h1>
      <p className="sub">
        Legacy admin parity (B5.2). <code>GET /api/businesses</code> is a{" "}
        <strong>global, unfiltered listing</strong> — every business on this server, NOT an
        owner-scoped "My Businesses". A business id is not proof of ownership.
      </p>

      <h2 className="sech">Create business</h2>
      <div className="need">
        {st.projects === null ? (
          <div className="nrow">
            <StatusBadge tone="warn" label="UNAVAILABLE" />
            <span className="note">
              project list unavailable ({st.projectsErr}) — creation blocked fail-closed: a project_id
              cannot be verified, never guess one.
            </span>
          </div>
        ) : (
          <>
            <div className="nrow">
              <span className="tt">Name*</span>
              <input
                className="inp"
                value={form.name}
                aria-label="business name"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="acme corp"
              />
            </div>
            <div className="nrow">
              <span className="tt">Project*</span>
              <select
                className="inp"
                value={form.project_id}
                aria-label="project"
                onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value }))}
              >
                <option value="">— select a project (verified via GET /api/projects) —</option>
                {st.projects.map((p) => (
                  <option key={String(p.project_id)} value={String(p.project_id)}>
                    {String(p.project_id)}{p.name ? ` — ${String(p.name)}` : ""}
                  </option>
                ))}
              </select>
              <span className="note">
                projects are a global server list — presence ≠ owner authorization (backend still
                enforces FAIL_CLOSED_BUSINESS_PROJECT)
              </span>
            </div>
            <div className="nrow">
              <span className="tt">Description</span>
              <input
                className="inp"
                value={form.description}
                aria-label="description"
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="nrow">
              <span className="tt">Currency</span>
              <input
                className="inp"
                value={form.currency}
                aria-label="currency"
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                placeholder="USD (default)"
              />
            </div>
            {!form.name.trim() || !form.project_id.trim() ? (
              <div className="nrow"><span className="note">name and project_id are required.</span></div>
            ) : null}
            <div className="actbar">
              <button className="tbtn" disabled={!valid} onClick={() => setDlg({ ...form })}>
                Create business…
              </button>
            </div>
          </>
        )}
      </div>

      {created ? (
        <div className="need">
          <div className="nrow">
            <StatusBadge tone="ok" label="CREATED" />
            <span className="tt"><code>{created.business_id}</code> — {created.name}</span>
            <button className="tbtn" onClick={() => select(String(created.business_id))}>
              Select this business
            </button>
          </div>
        </div>
      ) : null}
      {mutNote ? <div className="trunc" role="status">{mutNote}</div> : null}

      <h2 className="sech">Inspect a business</h2>
      <div className="need">
        <div className="nrow">
          <input
            className="inp"
            value={inspectId}
            aria-label="business id to inspect"
            onChange={(e) => setInspectId(e.target.value)}
            placeholder="BIZ_…"
          />
          <button className="tbtn" disabled={!inspectId.trim()} onClick={() => inspect(inspectId)}>
            Inspect
          </button>
        </div>
        {st.detailErr ? (
          <div className="nrow"><StatusBadge tone="danger" label="ERROR" /><span className="note">{st.detailErr}</span></div>
        ) : null}
        {st.detailFor && !st.detail && !st.detailErr ? (
          <div className="nrow" data-testid="inspect-loading">
            <StatusBadge tone="info" label="LOADING" />
            <span className="note">inspecting <code>{st.detailFor}</code>…</span>
          </div>
        ) : null}
        {st.detail && st.detailFor ? (
          <div className="nrow" style={{ display: "block" }}>
            <div><strong>{String(st.detail.business.name)}</strong> <code>{st.detail.business.business_id}</code></div>
            <div className="note">
              project <code>{String(st.detail.business.project_id)}</code> · currency {String(st.detail.business.currency ?? "USD")} ·
              status {String(st.detail.business.status)} · created {String(st.detail.business.created_at ?? "").slice(0, 10)}
            </div>
            <div className="need inspectbundle">
              <div className="nrow"><span className="tt">Agents ({Array.isArray(st.detail.agents) ? st.detail.agents.length : "?"})</span></div>
              {(Array.isArray(st.detail.agents) ? st.detail.agents : []).map((a) => (
                <div className="nrow" key={String(a.agent_id)}>
                  <StatusBadge tone={a.status === "ACTIVE" ? "ok" : a.status === "PAUSED" ? "warn" : "unknown"} label={String(a.status)} />
                  <span>{a.title}</span><code className="note">{String(a.agent_id)}</code>
                  <span className="note">{a.department}{a.role ? ` · ${a.role}` : ""}</span>
                </div>
              ))}
              <div className="nrow"><span className="tt">Objectives ({Array.isArray(st.detail.objectives) ? st.detail.objectives.length : "?"})</span></div>
              {(Array.isArray(st.detail.objectives) ? st.detail.objectives : []).map((o) => (
                <div className="nrow" key={String(o.objective_id)}>
                  <span>{o.title}</span><code className="note">{String(o.objective_id)}</code>
                  {o.metric || o.target ? <span className="note">{String(o.metric ?? "")} → {String(o.target ?? "")}</span> : null}
                </div>
              ))}
              <div className="nrow"><span className="tt">Routines ({Array.isArray(st.detail.routines) ? st.detail.routines.length : "?"})</span></div>
              {(Array.isArray(st.detail.routines) ? st.detail.routines : []).map((r) => (
                <div className="nrow" key={String(r.routine_id)}>
                  <StatusBadge tone={r.enabled ? "ok" : "unknown"} label={r.enabled ? "ENABLED" : "DISABLED"} />
                  <span>{r.name}</span><code className="note">{r.cron}</code>
                </div>
              ))}
              <div className="nrow"><span className="tt">Work items (board columns)</span></div>
              {Object.entries(st.detail.board ?? {}).flatMap(([status, rows]) =>
                (Array.isArray(rows) ? rows : []).map((w) => ({ status, w })),
              ).map(({ status, w }) => {
                const row = w as Record<string, unknown>;
                return (
                  <div className="nrow" key={String(row.work_item_id)}>
                    <StatusBadge tone={status === "DONE" ? "ok" : status === "BLOCKED" ? "danger" : status === "IN_PROGRESS" ? "purple" : "info"} label={status} />
                    <span>{String(row.title ?? "")}</span>
                    <code className="note">{String(row.work_item_id)}</code>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <h2 className="sech">Global business list</h2>
      {st.businesses === null ? (
        <div className="need"><div className="nrow">
          <StatusBadge tone="warn" label="UNAVAILABLE" />
          <span className="note">global list unavailable ({st.businessesErr}) — not shown as empty.</span>
        </div></div>
      ) : st.businesses.length === 0 ? (
        <EmptyState title="No businesses" detail="The global listing returned zero businesses." />
      ) : (
        <div className="need">
          {st.businesses.map((b) => (
            <div className="nrow" key={String(b.business_id)}>
              <span className="tt">{b.name}</span>
              <code className="note">{String(b.business_id)}</code>
              <span className="note">{String(b.created_at ?? "").slice(0, 10)}</span>
              <button className="tbtn" onClick={() => inspect(String(b.business_id))}>inspect</button>
              <button className="tbtn" onClick={() => select(String(b.business_id))}>select</button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={dlg !== null}
        title="Create business"
        body={`Create business "${dlg?.name}" in project ${dlg?.project_id}? This POSTs /api/businesses — the canonical creation seam. No objectives, agents or work items are auto-created.`}
        confirmLabel="Create"
        busy={mutBusy}
        onConfirm={submit}
        onCancel={() => setDlg(null)}
      />
    </div>
  );
}
