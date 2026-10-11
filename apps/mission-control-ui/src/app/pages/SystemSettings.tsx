import { useState } from "react";
import { Link } from "react-router-dom";
import { getAuthToken, setAuthToken, getOperatorId, setOperatorId } from "../../api";
import { reconnectStream } from "../../hooks/eventBus";
import { useTheme } from "../../lib/useTheme";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusBadge } from "../components/StatusBadge";

/* P15.9-B5.5 Scope E — Settings. Existing browser-session credentials
   only: pair.mc_token / pair.operator_id / pair.theme in localStorage —
   the same keys the whole UI already reads. No new auth backend, no
   encrypted-vault claims, and the stored token value is NEVER rendered
   (masked input, configured/unconfigured indicator only). */

export function SystemSettings() {
  const [tok, setTok] = useState("");
  const [configured, setConfigured] = useState(() => getAuthToken() !== "");
  const [op, setOp] = useState(getOperatorId);
  const [theme, toggleTheme] = useTheme();
  const [confirmClear, setConfirmClear] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const saveToken = () => {
    if (!tok.trim()) return;
    setAuthToken(tok);
    setTok("");
    setConfigured(true);
    /* R1-F3 — a credential change invalidates credential-scoped state:
       the SSE stream is reconnected (its previously-authenticated event
       buffer is cleared, never shown as current data), live-refreshed
       projections refetch under the new token, and Inbox Counts are
       invalidated via pair.credentials-changed (in-flight responses
       fetched under the old credential can never repaint as current). */
    reconnectStream();
    window.dispatchEvent(new Event("pair.credentials-changed"));
    setNote(
      "Token saved. New API requests use it immediately; inbox counts and live-refreshed projections were invalidated and refetch under the new credential; the event stream was reconnected with a cleared buffer.",
    );
  };

  const clearToken = () => {
    setAuthToken("");
    setConfigured(false);
    reconnectStream();
    window.dispatchEvent(new Event("pair.credentials-changed"));
    setConfirmClear(false);
    setNote("Token cleared — subsequent requests are unauthenticated and will fail closed (401); the event stream buffer was cleared and reconnected.");
  };

  const saveOp = () => {
    setOperatorId(op);
    /* R1-F3 — the operator id feeds the x-operator-id header of
       subsequent requests AND invalidates owner-dependent Inbox Counts
       (pair.operator-changed bumps the provider's invalidation epoch so
       a response fetched under the old operator never repaints). */
    window.dispatchEvent(new Event("pair.operator-changed"));
    setNote(
      `Operator id saved (${getOperatorId() || "none"}) — subsequent requests send x-operator-id; inbox counts were invalidated and refetch under the new identity. This is a request identity header, not proof of multi-tenant authorization.`,
    );
  };

  return (
    <div className="page narrow">
      <h1>Settings</h1>
      <p className="sub srcnote">
        Browser-session preferences stored in localStorage (<code>pair.mc_token</code>,{" "}
        <code>pair.operator_id</code>, <code>pair.theme</code>) — the same keys every page already
        uses. localStorage is plain browser storage, not an encrypted vault.
      </p>

      {note ? <div className="state" role="status" style={{ padding: 8, border: "1px solid var(--line)", borderRadius: 8 }}>{note}</div> : null}

      <section className="need" aria-label="session token">
        <h2>Session token</h2>
        <div className="nrow">
          <span className="tt">Status</span>
          <StatusBadge tone={configured ? "ok" : "warn"} label={configured ? "configured" : "unconfigured"} />
        </div>
        <div className="nrow" style={{ display: "block" }}>
          <label htmlFor="tokin">New token (masked — the stored value is never shown)</label>
          <input
            id="tokin"
            className="inp"
            type="password"
            autoComplete="off"
            value={tok}
            onChange={(e) => setTok(e.target.value)}
            placeholder="paste Mission Control token"
          />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="primary" disabled={!tok.trim()} onClick={saveToken}>Save token</button>
          <button className="danger" disabled={!configured} onClick={() => setConfirmClear(true)}>Clear token…</button>
        </div>
        <p className="sub srcnote">
          Saved to <code>pair.mc_token</code>. Sent as <code>Authorization: Bearer</code> on API
          requests. If requests fail with <code>UNAUTHORIZED</code> the token is wrong — pages show an
          honest Unauthorized state; no legacy popup appears on modern routes.
        </p>
      </section>

      <section className="need" aria-label="operator identity">
        <h2>Operator identity</h2>
        <div className="nrow" style={{ display: "block" }}>
          <label htmlFor="opin">x-operator-id sent with API requests (e.g. op:e2e)</label>
          <input id="opin" className="inp" value={op} onChange={(e) => setOp(e.target.value)} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="primary" onClick={saveOp}>Save operator id</button>
        </div>
        <p className="sub srcnote">
          Saved to <code>pair.operator_id</code> — propagates to the header of subsequent requests and
          the shell operator chip. Not proof of authorization: the backend decides per request.
        </p>
      </section>

      <section className="need" aria-label="theme">
        <h2>Theme</h2>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <StatusBadge tone="info" label={theme === "dark" ? "dark" : "light"} />
          <button className="tbtn" onClick={toggleTheme} aria-label="toggle theme in settings">
            Switch to {theme === "dark" ? "light" : "dark"}
          </button>
        </div>
        <p className="sub srcnote">
          Saved to <code>pair.theme</code> via <code>data-theme</code> — the same contract as the
          legacy UI and the shell toggle (stays synchronized).
        </p>
      </section>

      <section className="need" aria-label="legacy navigation">
        <h2>Legacy UI</h2>
        <p className="sub srcnote">The legacy dashboard remains available — nothing was cut over.</p>
        <Link className="lnk" to="/">Open legacy dashboard →</Link>
      </section>

      <ConfirmDialog
        open={confirmClear}
        title="Clear session token"
        body="Remove the stored Mission Control token from this browser? All subsequent API requests will be unauthenticated (401 fail-closed) until a new token is saved."
        confirmLabel="Clear token"
        onConfirm={clearToken}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
