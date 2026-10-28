import { useState } from "react";
import { Link } from "react-router-dom";
import { apiAdmin, getAuthToken, setAuthToken, getOperatorId, setOperatorId } from "../../api";
import { hasPersonalSession, personalSessionInfo, logoutPersonal } from "../../session";
import { reconnectStream, useLiveRefresh } from "../../hooks/eventBus";
import { useApi } from "../../hooks/useApi";
import { useTheme } from "../../lib/useTheme";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusBadge } from "../components/StatusBadge";
import type { ExecutorRow } from "../types";

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
  /* Personal Mode — a server-managed session owns the credential; the
     manual token/operator fields move behind an explicit advanced
     disclosure (rollback/remote flows keep working there). */
  const personal = hasPersonalSession() ? personalSessionInfo() : null;

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

      {personal ? (
        <section className="need" aria-label="system connection">
          <h2>Kết nối hệ thống</h2>
          <div className="nrow">
            <span className="tt">Trạng thái</span>
            <StatusBadge tone="ok" label="Đã kết nối" />
          </div>
          <div className="nrow">
            <span className="tt">Người vận hành</span>
            <code>{personal.operator}</code>
          </div>
          <div className="nrow">
            <span className="tt">Chế độ</span>
            <StatusBadge tone="info" label="Máy cá nhân (local)" />
          </div>
          <p className="sub srcnote">
            Phiên đăng nhập do server quản lý trên listener loopback — không cần token hay Operator ID.
            Phiên hết hạn lúc <code>{personal.expires_at}</code>; tự gia hạn khi mở lại PairNext.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="danger"
              onClick={() => {
                void logoutPersonal().then(() => {
                  setNote("Đã đăng xuất phiên cá nhân — tải lại trang sẽ tạo phiên mới.");
                });
              }}
            >
              Đăng xuất phiên…
            </button>
          </div>
        </section>
      ) : null}

      <details className="need" aria-label="advanced credentials" {...(personal ? {} : { open: true })}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          {personal ? "Nâng cao — token thủ công (truy cập từ xa / khôi phục)" : "Session token"}
        </summary>

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
      </details>

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

      <ExecutorsSection onNote={setNote} />

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

/* Executor Management — durable ON/OFF intent over the canonical
   executor registry (audited, OCC-safe). OFF blocks every NEW dispatch
   (fresh routes, retries, reroutes) via CapabilityRouter +
   GovernedTaskGate and never cancels running executions. ON flips
   intent only — qualification/health/capability/route gates still
   decide whether anything can actually dispatch; a registered-but-
   unbound executor reports requires_restart (a toggle can't conjure an
   adapter — bootstrap + restart can). */
function ExecutorsSection({ onNote }: { onNote: (s: string) => void }) {
  const { data, error, loading, reload } = useApi(
    () => apiAdmin.executors(),
    [],
    15000,
  );
  useLiveRefresh(reload);
  const [confirm, setConfirm] = useState<ExecutorRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (row: ExecutorRow) => {
    const next = !row.enabled;
    if (!next) {
      // OFF is high-impact (blocks new dispatches) — confirm first.
      setConfirm(row);
      return;
    }
    setBusy(row.executor_id);
    try {
      await apiAdmin.setExecutorEnabled(row.executor_id, true);
      onNote(`${row.executor_id} enabled — new dispatches may now route to it (qualification and route eligibility still apply).`);
      reload();
    } catch (e) {
      onNote(`Enable ${row.executor_id} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const doDisable = async () => {
    const row = confirm;
    setConfirm(null);
    if (!row) return;
    setBusy(row.executor_id);
    try {
      await apiAdmin.setExecutorEnabled(row.executor_id, false);
      onNote(`${row.executor_id} disabled — new dispatches (including retries and reroutes) are blocked; running executions are unaffected.`);
      reload();
    } catch (e) {
      onNote(`Disable ${row.executor_id} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const rows = data?.executors ?? [];
  return (
    <section className="need" aria-label="executor management">
      <h2>Executor Management</h2>
      {loading && !data ? <div className="state">Loading executors…</div> : null}
      {error ? (
        <div className="state" role="alert">
          {error instanceof Error ? error.message : String(error)}
        </div>
      ) : null}
      {rows.length === 0 && data ? (
        <div className="state">No executors reported by the backend.</div>
      ) : null}
      {rows.map((r) => (
        <div key={r.executor_id} className="nrow" style={{ alignItems: "flex-start" }}>
          <span className="tt" style={{ minWidth: 150 }}>
            <code>{r.executor_id}</code>
          </span>
          <div style={{ flex: 1 }}>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <StatusBadge tone={r.enabled ? "ok" : "unknown"} label={r.enabled ? "on" : "off"} />
              <StatusBadge
                tone={r.qualification_state === "QUALIFIED" ? "ok" : "warn"}
                label={r.qualification_state === "QUALIFIED" ? "qualified" : "unqualified"}
              />
              <StatusBadge
                tone={r.availability_state === "AVAILABLE" ? "ok" : "warn"}
                label={r.availability_state === "AVAILABLE" ? "available" : "unavailable"}
              />
              {r.requires_restart ? (
                <StatusBadge tone="warn" label="restart required" />
              ) : null}
            </div>
            {r.missing_prerequisites.length ? (
              <p className="sub srcnote" style={{ margin: "4px 0 0" }}>
                missing: {r.missing_prerequisites.join("; ")}
              </p>
            ) : null}
            {r.requires_restart ? (
              <p className="sub srcnote" style={{ margin: "4px 0 0" }}>
                registered but no adapter is bound in this process — enabling alone will not
                dispatch; reconfigure the environment and restart.
              </p>
            ) : null}
          </div>
          <button
            className={r.enabled ? "danger" : "primary"}
            disabled={!r.registered || busy === r.executor_id}
            title={
              !r.registered
                ? "not registered on this backend — configure the required environment and restart"
                : r.enabled
                  ? "disable: block all new dispatches"
                  : "enable: allow new dispatches (gates still apply)"
            }
            onClick={() => void toggle(r)}
          >
            {r.enabled ? "Disable…" : "Enable"}
          </button>
        </div>
      ))}
      <p className="sub srcnote">
        Durable backend state — persists across restarts. OFF blocks new dispatches only; running
        executions keep settling. CEO/Planner model configuration is independent of these toggles.
      </p>
      <ConfirmDialog
        open={confirm !== null}
        title={`Disable ${confirm?.executor_id ?? ""}`}
        body={`Disable ${confirm?.executor_id ?? "this executor"}? No NEW dispatches will route to it — including retries and reroutes — until it is re-enabled. Executions already running are not cancelled.`}
        confirmLabel="Disable executor"
        onConfirm={() => void doDisable()}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
