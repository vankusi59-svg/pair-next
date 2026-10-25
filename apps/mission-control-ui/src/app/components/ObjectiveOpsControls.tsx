import { useState } from "react";
import { apiAdmin, ApiError } from "../../api";
import { StatusBadge, type Tone } from "./StatusBadge";
import { ConfirmDialog } from "./ConfirmDialog";

/* P18.1 — Objective controls: owner lifecycle transitions through
   POST /api/vnext/objectives/:id/transition (PAUSE/RESUME/CANCEL).
   The canonical service owns the legal-transition table — this panel
   mirrors it ONLY to decide which buttons to offer; every commit is
   re-validated server-side and a typed FAIL_CLOSED_OBJECTIVE_TRANSITION
   is surfaced verbatim (its detail carries the real `from → to`).
   Authority is the x-operator-id header the transport layer sets —
   no owner/actor field is ever sent in a body. ACHIEVED is never a
   raw transition here: owner achievement goes through review sign-off. */

/* Mirrors TERMINAL_OBJECTIVE_STATUSES in objective-authority.ts —
   terminal rows have no legal exits at all. */
const TERMINAL_STATUSES = new Set(["ACHIEVED", "INFEASIBLE", "EXPIRED", "CANCELLED"]);

const S_TONE: Record<string, Tone> = {
  ACTIVE: "ok", PAUSED: "warn", BLOCKED: "danger",
  ACHIEVED: "ok", INFEASIBLE: "danger", EXPIRED: "warn", CANCELLED: "unknown",
};

/* Transition targets the UI may request — the only values the client
   contract accepts. Which button is offered for the observed status
   mirrors OBJECTIVE_TRANSITIONS in the service. */
type Target = "PAUSED" | "ACTIVE" | "CANCELLED";

const ACTION_META: Record<Target, { label: string; verb: string; destructive: boolean }> = {
  PAUSED: { label: "Pause objective", verb: "pause", destructive: false },
  ACTIVE: { label: "Resume objective", verb: "resume", destructive: false },
  CANCELLED: { label: "Cancel objective", verb: "cancel", destructive: true },
};

export function ObjectiveOpsControls(props: {
  objective: { objective_id: string; business_id: string; status: string };
  onChanged?: () => void;
}): JSX.Element {
  const { objective, onChanged } = props;
  const [dlg, setDlg] = useState<{ to: Target } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /* The status captured when the dialog opened — the committed body and
     the failure wording always describe THAT from-state, never a status
     that changed under the owner's feet between open and confirm. */
  const [dlgFrom, setDlgFrom] = useState<string | null>(null);

  const status = String(objective.status ?? "");
  const terminal = TERMINAL_STATUSES.has(status);
  const canPause = status === "ACTIVE" || status === "BLOCKED";
  const canResume = status === "PAUSED";
  const canCancel = !terminal;
  const noActions = !canPause && !canResume && !canCancel;

  const open = (to: Target) => {
    setReason("");
    setNote(null);
    setDlgFrom(status);
    setDlg({ to });
  };

  const run = () => {
    if (!dlg) return;
    const to = dlg.to;
    const from = dlgFrom ?? status;
    setDlg(null);
    setBusy(true);
    setNote(null);
    apiAdmin
      .objectiveTransitionApp(objective.objective_id, {
        business_id: objective.business_id,
        to,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })
      .then((r) => {
        setBusy(false);
        const o = r?.objective;
        /* Fail-closed identity: a committed response naming a different
           objective is reported as inconsistent, never as success. */
        if (!o || String(o.objective_id ?? "") !== objective.objective_id) {
          setNote(
            `Transition ${from} → ${to}: response identity mismatch — the commit may still have landed; refresh before retrying.`,
          );
          onChanged?.();
          return;
        }
        setNote(
          `Transition committed — ${from} → ${String(o.status ?? to)}` +
            (o.status_reason ? ` · reason: ${String(o.status_reason)}` : ""),
        );
        onChanged?.();
      })
      .catch((e: unknown) => {
        setBusy(false);
        if (e instanceof ApiError && e.code === "FAIL_CLOSED_OBJECTIVE_TRANSITION") {
          /* The service's detail IS the real `from → to` — render it
             verbatim so the owner sees the canonical pair, not a guess. */
          const pair = e.detail && e.detail.includes("→") ? e.detail : `${from} → ${to}`;
          setNote(`${pair} is not a legal transition — the objective was not changed. (${e.code})`);
          return;
        }
        setNote(
          `Transition ${from} → ${to} failed: ${
            e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e)
          }`,
        );
      });
  };

  return (
    <section aria-label="Objective controls">
      <h2 className="sech">Objective controls</h2>
      <div className="need">
        <div className="nrow">
          <span className="tt">status</span>
          <StatusBadge tone={S_TONE[status] ?? "unknown"} label={status || "NOT_OBSERVED"} />
          <span className="note">
            {terminal
              ? "terminal — no legal transitions remain"
              : "owner transitions post the canonical lifecycle seam"}
          </span>
        </div>
      </div>

      {note ? <div className="trunc" role="status">{note}</div> : null}

      <div className="actions">
        {canPause ? (
          <button
            className="ghost"
            disabled={busy}
            title="Transition ACTIVE|BLOCKED → PAUSED — the scheduler keeps the objective registered but stops consuming it"
            onClick={() => open("PAUSED")}
          >
            Pause objective
          </button>
        ) : null}
        {canResume ? (
          <button
            className="ghost"
            disabled={busy}
            title="Transition PAUSED → ACTIVE — resumes owner-authorized scheduling"
            onClick={() => open("ACTIVE")}
          >
            Resume objective
          </button>
        ) : null}
        {canCancel ? (
          <button
            className="danger"
            disabled={busy}
            title="Transition to CANCELLED — terminal, cannot be reactivated"
            onClick={() => open("CANCELLED")}
          >
            Cancel objective
          </button>
        ) : null}
      </div>
      {noActions && !terminal ? (
        <div className="sub">No lifecycle transitions are offered for status {status || "NOT_OBSERVED"} — the canonical service decides legality.</div>
      ) : null}
      <div className="sub">
        ACHIEVED is never a raw transition — achievement requires review sign-off
        (accept the TARGET_MET_CANDIDATE review in the Inbox).
      </div>

      <ConfirmDialog
        open={dlg !== null}
        title={dlg ? ACTION_META[dlg.to].label : "Objective transition"}
        body={
          dlg?.to === "CANCELLED"
            ? `Cancel ${objective.objective_id}? Cancelling is terminal — the objective cannot be reactivated, and scheduler/driver work for it stops. The canonical service re-validates the transition on commit.`
            : dlg
              ? `${ACTION_META[dlg.to].verb === "pause" ? "Pause" : "Resume"} ${objective.objective_id} (${dlgFrom ?? status} → ${dlg.to})? The canonical service re-validates the transition on commit.`
              : ""
        }
        confirmLabel={dlg ? `Commit ${dlg.to}` : "Commit"}
        busy={busy}
        onConfirm={run}
        onCancel={() => setDlg(null)}
      >
        {dlg ? (
          <div className="ofrow" aria-label="transition reason">
            <label htmlFor="obj-ops-reason">reason (optional — recorded on the canonical row)</label>
            <input
              id="obj-ops-reason"
              placeholder={`why ${ACTION_META[dlg.to].verb} this objective`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
