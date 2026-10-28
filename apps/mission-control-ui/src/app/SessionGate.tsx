import { useEffect, useState, type ReactNode } from "react";
import {
  fetchPersonalStatus,
  bootstrapPersonal,
  selectPersonalOwner,
  type PersonalStatus,
} from "../session";
import { setOperatorId } from "../api";
import { setBusinessId } from "./AppShell";

/* Personal Mode — the /app/* session bootstrap gate. Runs BEFORE any
   ordinary API/SSE traffic so no transient-401 storm, stale stream or
   cross-identity paint can happen:
     mode off          → render children (legacy bearer flow untouched)
     session valid     → pin operator + business, render
     no session, local → silent bootstrap → render (zero-friction path)
     >1 owners         → one-time explicit picker (never a silent merge)
     remote ingress    → render children (bearer/token flow as before)
   Session authority is server-pinned; this component only mirrors the
   resolved identity into the shell's display/localStorage context. */

function applySessionIdentity(s: PersonalStatus["session"]) {
  if (!s) return;
  // The server pins this operator for session requests — keeping the
  // header in sync avoids FAIL_CLOSED_PERSONAL_OPERATOR_CONFLICT and
  // fills the shell chip + owner-scoped reads with the same value.
  setOperatorId(s.operator);
  window.dispatchEvent(new Event("pair.operator-changed"));
  if (s.business_id) setBusinessId(s.business_id);
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"loading" | "ready" | "pick-owner" | "error">("loading");
  const [status, setStatus] = useState<PersonalStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setErr(null);
    try {
      const st = await fetchPersonalStatus();
      if (!st.personal_mode) {
        setPhase("ready");
        return;
      }
      if (st.session) {
        applySessionIdentity(st.session);
        setPhase("ready");
        return;
      }
      if (st.ingress !== "local") {
        // Remote/tunneled access — personal session can never be
        // minted here; the existing bearer/token flow handles auth.
        setPhase("ready");
        return;
      }
      const boot = await bootstrapPersonal();
      if (boot.session) {
        applySessionIdentity(boot.session);
        setPhase("ready");
        return;
      }
      if (boot.needs_owner_selection) {
        setStatus(boot);
        setPhase("pick-owner");
        return;
      }
      setPhase("ready");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    void connect();
  }, []);

  const pick = async (owner: string) => {
    setBusy(true);
    try {
      const st = await selectPersonalOwner(owner);
      applySessionIdentity(st.session);
      setPhase("ready");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (phase === "loading") {
    return (
      <div className="page narrow" style={{ paddingTop: "20vh", textAlign: "center" }}>
        <h1>Đang kết nối PairNext…</h1>
        <p className="sub srcnote">Thiết lập phiên làm việc trên máy cá nhân</p>
      </div>
    );
  }

  if (phase === "pick-owner" && status) {
    return (
      <div className="page narrow" style={{ paddingTop: "12vh" }}>
        <h1>Chọn chủ sở hữu</h1>
        <p className="sub">
          Hệ thống tìm thấy nhiều danh tính owner đã tồn tại. Chọn đúng một lần — PairNext sẽ ghi nhớ
          và không hỏi lại. Không có quyền nào được chuyển ngầm.
        </p>
        <div className="need" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {status.owner_candidates.map((o) => (
            <button
              key={o}
              className="primary"
              style={{ textAlign: "left", padding: "10px 14px" }}
              disabled={busy}
              onClick={() => void pick(o)}
            >
              {o}
            </button>
          ))}
        </div>
        {err ? <div className="state" role="alert" style={{ marginTop: 8 }}>{err}</div> : null}
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="page narrow" style={{ paddingTop: "20vh", textAlign: "center" }}>
        <h1>Không kết nối được PairNext</h1>
        <p className="sub" role="alert">{err ?? "lỗi không xác định"}</p>
        <button className="primary" onClick={() => { setPhase("loading"); void connect(); }}>
          Thử kết nối lại
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
