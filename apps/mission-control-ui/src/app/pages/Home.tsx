import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, apiAdmin } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import { EmptyState } from "../components/states";
import { StatusBadge } from "../components/StatusBadge";
import type { OperationsOverview } from "../types";

/* UI-V2 Phase C — owner dashboard (Tổng quan).
 * NL entry above compact canonical status. Every count links back to its
 * source list; unavailable lanes render honest markers — never fake data,
 * derived percentages or ETAs. Partial API failure stays calm. */

const GOAL_MAX = 4000;

type Tone = import("../components/StatusBadge").Tone;
const toneOf = (s: unknown): Tone => {
  const v = String(s ?? "").toUpperCase();
  if (["ACTIVE", "COMPLETED", "DONE", "ACHIEVED", "READY"].includes(v)) return "ok";
  if (["RUNNING", "IN_PROGRESS", "CREATED", "PENDING", "OPEN"].includes(v)) return "info";
  if (["PAUSED", "WAITING_APPROVAL", "REVIEW_REQUIRED", "PLANNING"].includes(v)) return "warn";
  if (["FAILED", "BLOCKED", "CANCELLED", "TERMINATED", "REJECTED"].includes(v)) return "danger";
  return "unknown";
};

export function Home() {
  const nav = useNavigate();
  const { biz } = useSelectedBusiness();
  const [goal, setGoal] = useState("");

  const [ops, setOps] = useState<OperationsOverview["operations"] | null>(null);
  const [opsDown, setOpsDown] = useState(false);
  const [objectives, setObjectives] = useState<Array<Record<string, unknown>> | null>(null);
  const [objDown, setObjDown] = useState(false);
  const [missions, setMissions] = useState<Array<Record<string, unknown>> | null>(null);
  const [missionsDown, setMissionsDown] = useState(false);
  const [approvals, setApprovals] = useState<Array<Record<string, unknown>> | null>(null);
  const [approvalsDown, setApprovalsDown] = useState(false);
  const [reviewsPending, setReviewsPending] = useState<number | null>(null);
  const [agents, setAgents] = useState<import("../types").OrgAgentRow[] | null>(null);
  const [workItems, setWorkItems] = useState<import("../types").WorkItemRow[] | null>(null);
  const [bizDown, setBizDown] = useState(false);

  const isAbort = (e: unknown) =>
    e instanceof DOMException && e.name === "AbortError";

  /* Global reads run once — not re-fetched on business switch. */
  useEffect(() => {
    const ctl = new AbortController();
    const s = ctl.signal;
    const live = () => !s.aborted;
    apiAdmin
      .operationsOverview(s)
      .then((r) => { if (live()) setOps(r.operations); })
      .catch((e) => { if (!isAbort(e) && live()) setOpsDown(true); });
    api
      .missions({ noAuthPrompt: true })
      .then((r) => { if (live()) setMissions((r.missions as Array<Record<string, unknown>>) ?? []); })
      .catch((e) => { if (!isAbort(e) && live()) setMissionsDown(true); });
    api
      .approvalsNoPrompt()
      .then((a) => { if (live()) setApprovals(Array.isArray(a) ? a : []); })
      .catch((e) => { if (!isAbort(e) && live()) setApprovalsDown(true); });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Business-scoped reads — reset on every switch so tenant A's rows can
     never render under tenant B, and stale responses are dropped by the
     abort guard (last-write-wins). */
  useEffect(() => {
    const ctl = new AbortController();
    const s = ctl.signal;
    const live = () => !s.aborted;
    setObjectives(null);
    setObjDown(false);
    setReviewsPending(null);
    setAgents(null);
    setWorkItems(null);
    setBizDown(false);
    if (!biz) {
      setObjectives([]);
      setAgents([]);
      setWorkItems([]);
      return;
    }
    api
      .vnextObjectives(biz, { noAuthPrompt: true })
      .then((r) => { if (live()) setObjectives(r.objectives as Array<Record<string, unknown>>); })
      .catch((e) => { if (!isAbort(e) && live()) setObjDown(true); });
    api
      .businessCompany(biz, s)
      .then((r) => { if (live()) setReviewsPending(r.company.counts.targets_met_pending); })
      .catch((e) => { if (!isAbort(e) && live()) setReviewsPending(null); });
    api
      .orgAgents(s)
      .then((r) => { if (live()) setAgents((r.agents ?? []).filter((a) => a.business_id === biz)); })
      .catch((e) => { if (!isAbort(e) && live()) setBizDown(true); });
    api
      .workItems(biz, s)
      .then((r) => { if (live()) setWorkItems(r.work_items ?? []); })
      .catch((e) => { if (!isAbort(e) && live()) setBizDown(true); });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biz]);

  const activeObjectives = useMemo(
    () => (objectives ?? []).filter((o) => String(o.status) === "ACTIVE"),
    [objectives],
  );
  const runningMissions = useMemo(
    () =>
      (missions ?? []).filter((m) =>
        ["RUNNING", "CREATED"].includes(String(m.status ?? m.runtime_state ?? "")),
      ),
    [missions],
  );
  const pendingApprovals = useMemo(
    () => (approvals ?? []).filter((a) => String(a.status) === "PENDING"),
    [approvals],
  );
  const recentDone = useMemo(
    () =>
      (missions ?? [])
        .filter((m) => ["COMPLETED", "DONE"].includes(String(m.status ?? "")))
        .slice(0, 6),
    [missions],
  );
  const busyAgents = useMemo(() => {
    const inProgress = (workItems ?? []).filter((w) => String(w.status) === "IN_PROGRESS");
    const byAgent = new Map<string, string>();
    for (const w of inProgress) {
      const aid = String(w.assignee_agent_id ?? "");
      if (aid) byAgent.set(aid, String(w.title ?? w.work_item_id ?? ""));
    }
    return byAgent;
  }, [workItems]);

  /* Blocked work items only count when the ops rollup actually loaded —
     a failed read contributes an unknown amount, marked with "+". */
  const needCount =
    pendingApprovals.length + (reviewsPending ?? 0) +
    (ops?.work_items_blocked ?? 0);

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const g = goal.trim();
    if (!g) return;
    nav(`/app/new?goal=${encodeURIComponent(g)}`);
  };

  return (
    <div className="home">
      <div className="v2hero">
        <h1 className="v2hero-t">Bạn muốn PairNext thực hiện điều gì?</h1>
        <p className="v2hero-sub">
          Giao mục tiêu hoặc công việc bằng ngôn ngữ tự nhiên — PairNext đề xuất,
          bạn xác nhận.
        </p>
        <form onSubmit={go}>
          <textarea
            className="v2hero-in"
            aria-label="Mục tiêu hoặc công việc"
            placeholder="Ví dụ: Xây dựng sản phẩm EA giao dịch XAUUSD để bán trên MQL5 Market…"
            value={goal}
            maxLength={GOAL_MAX}
            rows={3}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) go(e);
            }}
          />
          <div className="v2hero-actions">
            <button className="v2btn primary" type="submit" disabled={goal.trim() === ""}>
              Phân tích yêu cầu →
            </button>
            <Link className="v2btn" to="/app/missions/new">Tạo thủ công</Link>
          </div>
        </form>
      </div>

      <div className="stats">
        <Link className="stat" to="/app/objectives">
          <div className="k">Objective đang hoạt động</div>
          <div className="v">{objectives === null ? (objDown ? "—" : "…") : activeObjectives.length}</div>
          <div className="n">{objDown ? "không đọc được" : "vnext objectives · ACTIVE"}</div>
        </Link>
        <Link className="stat" to="/app/missions">
          <div className="k">Mission đang chạy</div>
          <div className="v">
            {ops !== null ? ops.missions_active : missions !== null ? runningMissions.length : opsDown && missionsDown ? "—" : "…"}
          </div>
          <div className="n">canonical operations rollup</div>
        </Link>
        <Link className="stat" to="/app/inbox">
          <div className="k">Cần phê duyệt</div>
          <div className="v">
            {approvals === null
              ? approvalsDown
                ? "—"
                : "…"
              : `${needCount}${opsDown || reviewsPending === null ? "+" : ""}`}
          </div>
          <div className="n">
            {biz
              ? `approvals ${pendingApprovals.length} · reviews ${reviewsPending ?? "—"} · blocked ${ops?.work_items_blocked ?? "—"}`
              : `approvals ${pendingApprovals.length} · chọn business để đếm reviews`}
          </div>
        </Link>
        <Link className="stat" to="/app/missions">
          <div className="k">Kết quả gần đây</div>
          <div className="v">{missions === null ? (missionsDown ? "—" : "…") : recentDone.length}</div>
          <div className="n">mission COMPLETED gần nhất</div>
        </Link>
      </div>

      {!biz ? (
        <EmptyState
          title="Chưa chọn business"
          detail="Chọn một business ở góc trái sidebar để xem objectives, workforce và reviews. Bạn vẫn có thể tạo Mission ở trên — phần phê duyệt luôn ở Inbox."
        />
      ) : (
        <div className="hgrid">
          <section className="hcard">
            <div className="hh">
              <h2>Mục tiêu đang theo dõi</h2>
              <Link to="/app/objectives">Xem tất cả →</Link>
            </div>
            {objectives === null ? (
              <div className="hint">{objDown ? "Không đọc được objectives." : "Đang tải…"}</div>
            ) : activeObjectives.length === 0 ? (
              <div className="hint">Chưa có objective ACTIVE — tạo từ ô nhập phía trên.</div>
            ) : (
              activeObjectives.slice(0, 4).map((o) => (
                <Link className="hrow" key={String(o.objective_id)} to={`/app/objectives/${o.objective_id}`}>
                  <div className="hr-main">
                    <div className="hr-t">{String(o.title ?? o.objective_id)}</div>
                    <div className="hr-s">
                      {o.deadline ? `hạn ${String(o.deadline).slice(0, 10)}` : "chưa đặt hạn"}
                      {" · "}
                      {Array.isArray(o.kpis) ? `${o.kpis.length} KPI` : "0 KPI"}
                    </div>
                  </div>
                  <StatusBadge tone={toneOf(o.status)} label={String(o.status ?? "UNKNOWN")} />
                </Link>
              ))
            )}
          </section>

          <section className="hcard">
            <div className="hh">
              <h2>Cần bạn quyết định</h2>
              <Link to="/app/inbox">Mở Inbox →</Link>
            </div>
            {pendingApprovals.length === 0 ? (
              <div className="hint">
                {(reviewsPending ?? 0) === 0
                  ? "Không có gì chờ phê duyệt."
                  : `${reviewsPending} review chờ sign-off — xem trong Inbox.`}
              </div>
            ) : (
              pendingApprovals.slice(0, 5).map((a) => (
                <Link className="hrow" key={String(a.approval_id)} to="/app/inbox">
                  <div className="hr-main">
                    <div className="hr-t">{String(a.title ?? a.kind ?? a.approval_id)}</div>
                    <div className="hr-s">
                      {String(a.kind ?? "")} · {String(a.created_at ?? "").slice(0, 16).replace("T", " ")}
                    </div>
                  </div>
                  <span className="sbadge t-warn">PENDING</span>
                </Link>
              ))
            )}
          </section>

          <section className="hcard">
            <div className="hh">
              <h2>Hoạt động của Nhân sự AI</h2>
              <Link to="/app/workforce">Xem tất cả →</Link>
            </div>
            {agents === null ? (
              <div className="hint">{bizDown ? "Không đọc được workforce." : "Đang tải…"}</div>
            ) : agents.length === 0 ? (
              <div className="hint">Chưa có agent — tạo trong Workforce Admin.</div>
            ) : (
              agents.slice(0, 6).map((a) => (
                <Link className="hrow" key={String(a.agent_id)} to={`/app/workforce/${a.agent_id}`}>
                  <div className="hr-main">
                    <div className="hr-t">{String(a.title ?? a.agent_id)}</div>
                    <div className="hr-s">
                      {busyAgents.get(String(a.agent_id)) ?? "đang rảnh"}
                    </div>
                  </div>
                  <StatusBadge tone={toneOf(a.status)} label={String(a.status ?? "UNKNOWN")} />
                </Link>
              ))
            )}
          </section>

          <section className="hcard">
            <div className="hh">
              <h2>Kết quả gần đây</h2>
              <Link to="/app/missions">Xem tất cả →</Link>
            </div>
            {missions === null ? (
              <div className="hint">{missionsDown ? "Không đọc được missions." : "Đang tải…"}</div>
            ) : recentDone.length === 0 ? (
              <div className="hint">Chưa có mission hoàn thành nào.</div>
            ) : (
              recentDone.map((m) => (
                <Link className="hrow" key={String(m.mission_id)} to={`/app/missions/${m.mission_id}`}>
                  <div className="hr-main">
                    <div className="hr-t">{String(m.title ?? m.goal ?? m.mission_id).slice(0, 80)}</div>
                    <div className="hr-s">{String(m.completed_at ?? m.updated_at ?? "").slice(0, 16).replace("T", " ")}</div>
                  </div>
                  <StatusBadge tone={toneOf(m.status)} label={String(m.status ?? "UNKNOWN")} />
                </Link>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}
