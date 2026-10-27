import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState, ErrorState } from "../components/states";
import type { IntakeDraftResponse, IntakeItem } from "../types";

/* UI-V2 Phase B — unified natural-language intake.
 * The draft is NON-AUTHORITATIVE: owner reviews/edits every field, then
 * commits through the canonical seams only —
 *   objective → POST /api/vnext/objectives (dedup_key, canonical service)
 *   mission   → /app/missions/new?goal=… (existing preview/confirm flow)
 * Semantic interpretation is advisory evidence: mode OFF/unavailable
 * still yields an honest manual draft — never a fabricated analysis. */

type Prov = "explicit" | "suggested" | "unresolved" | "edited";

const PROV_LABEL: Record<Prov, string> = {
  explicit: "từ văn bản của bạn",
  suggested: "AI đề xuất",
  unresolved: "chưa có",
  edited: "bạn đã sửa",
};

function ProvTag({ p }: { p: Prov }) {
  return <span className={`pvtag pv-${p}`}>{PROV_LABEL[p]}</span>;
}

interface DraftState {
  title: string; titleProv: Prov;
  statement: string; statementProv: Prov;
  deadline: string; deadlineProv: Prov;
  budgetUsd: string; budgetProv: Prov;
  kpis: Array<{ name: string; target: string; unit: string; prov: Prov }>;
  hardConstraints: Array<{ text: string; prov: Prov }>;
  successConditions: Array<{ text: string; prov: Prov }>;
  workstreams: Array<{ text: string; prov: Prov }>;
}

function toDraftState(r: IntakeDraftResponse): DraftState {
  const d = r.draft;
  return {
    title: d.title.value ?? "",
    titleProv: d.title.provenance,
    statement: d.statement.value ?? "",
    statementProv: d.statement.provenance,
    deadline: d.deadline.value ?? "",
    deadlineProv: d.deadline.provenance,
    budgetUsd:
      d.budget_ceiling_microusd.value != null
        ? String(d.budget_ceiling_microusd.value / 1_000_000)
        : "",
    budgetProv: d.budget_ceiling_microusd.provenance,
    kpis: d.kpis.map((k) => ({
      name: k.name,
      target: k.target != null ? String(k.target) : "",
      unit: k.unit ?? "",
      prov: k.provenance,
    })),
    hardConstraints: d.hard_constraints.map((c) => ({ text: c.statement, prov: c.provenance })),
    successConditions: d.success_conditions.map((c) => ({ text: c.statement, prov: c.provenance })),
    workstreams: d.workstreams.map((w) => ({ text: w.statement, prov: w.provenance })),
  };
}

const GOAL_MAX = 4000;

export function Intake() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { biz } = useSelectedBusiness();
  const [goal, setGoal] = useState(params.get("goal") ?? "");
  const [resp, setResp] = useState<IntakeDraftResponse | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [kind, setKind] = useState<"objective" | "mission">("mission");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ code: string; detail: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  /* The business the displayed draft was analyzed against — confirm must
     commit into THAT scope or fail closed, never silently re-scope. */
  const [analyzedBiz, setAnalyzedBiz] = useState<string | null>(null);
  const dedupRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const analyze = async (manual = false) => {
    const g = goal.trim();
    if (!g || busy) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy(true);
    setErr(null);
    setResp(null);
    setDraft(null);
    setCreated(null);
    try {
      const r = await api.intakeDraft({
        goal: g,
        business_id: biz || null,
        ...(manual ? { manual: true } : {}),
      });
      if (ctl.signal.aborted) return;
      setResp(r);
      setDraft(toDraftState(r));
      setKind(r.draft.suggested_kind);
      setAnalyzedBiz(biz || null);
      dedupRef.current = `intake-${crypto.randomUUID()}`;
    } catch (e) {
      if (ctl.signal.aborted) return;
      const ae = e as ApiError;
      setErr({ code: ae.code ?? "ERROR", detail: ae.detail ?? String(e) });
    } finally {
      if (!ctl.signal.aborted) setBusy(false);
    }
  };

  const explicitItems = useMemo(
    () => (resp?.items ?? []).filter((i) => i.authority === "EXPLICIT_OPERATOR" && !isUnresolvedItem(i)),
    [resp],
  );
  const inferredItems = useMemo(
    () =>
      (resp?.items ?? []).filter(
        (i) =>
          (i.authority === "MODEL_INFERRED" || i.authority === "PROPOSED_AMENDMENT") &&
          !isUnresolvedItem(i),
      ),
    [resp],
  );

  /* Numeric fields must be valid-or-empty — a malformed value silently
     dropped at commit is dishonest. Block confirm with a stated reason. */
  const budgetInvalid = !!draft && draft.budgetUsd.trim() !== "" && !Number.isFinite(Number(draft.budgetUsd));
  /* Canonical create requires a numeric target for every named KPI —
     flag it instead of letting the whole create fail server-side. */
  const kpiTargetInvalid =
    !!draft &&
    draft.kpis.some(
      (k) => k.name.trim() !== "" && (k.target.trim() === "" || !Number.isFinite(Number(k.target))),
    );
  const bizDrift = resp !== null && analyzedBiz !== (biz || null);
  const canConfirmObjective =
    !!biz && !!draft && draft.title.trim() !== "" && draft.statement.trim() !== "" &&
    !busy && !bizDrift && !budgetInvalid && !kpiTargetInvalid;

  const confirmObjective = async () => {
    if (!draft || !biz || busy || bizDrift) return;
    setBusy(true);
    setErr(null);
    try {
      const body: import("../../types").VnextObjectiveInput = {
        business_id: biz,
        title: draft.title.trim(),
        statement: draft.statement.trim(),
        dedup_key: dedupRef.current ?? `intake-${crypto.randomUUID()}`,
      };
      const dl = draft.deadline.trim();
      if (dl) body.deadline = dl;
      const usd = Number(draft.budgetUsd);
      if (draft.budgetUsd.trim() !== "" && Number.isFinite(usd) && usd >= 0) {
        body.budget_ceiling_microusd = Math.round(usd * 1_000_000);
        body.currency = "USD";
      }
      const kpis = draft.kpis
        .filter((k) => k.name.trim() !== "")
        .map((k) => ({
          name: k.name.trim(),
          direction: "AT_LEAST",
          ...(k.target.trim() !== "" && Number.isFinite(Number(k.target))
            ? { target: Number(k.target) }
            : {}),
          ...(k.unit.trim() !== "" ? { unit: k.unit.trim() } : {}),
        }));
      if (kpis.length) body.kpis = kpis;
      const hc = draft.hardConstraints.map((c) => c.text.trim()).filter(Boolean);
      if (hc.length) body.hard_constraints = hc;
      const sc = draft.successConditions.map((c) => c.text.trim()).filter(Boolean);
      if (sc.length) body.success_conditions = sc;
      const o = await api.createObjectiveApp(body);
      setCreated(String(o.objective_id));
      setConfirmOpen(false);
    } catch (e) {
      const ae = e as ApiError;
      setErr({ code: ae.code ?? "ERROR", detail: ae.detail ?? String(e) });
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const goMission = () => {
    const g = (draft?.statement || goal).trim();
    nav(`/app/missions/new?goal=${encodeURIComponent(g)}`);
  };

  /* ---------- render ---------- */
  return (
    <div className="intake">
      <div className="v2hero">
        <h1 className="v2hero-t">Bạn muốn PairNext thực hiện điều gì?</h1>
        <p className="v2hero-sub">
          Giao mục tiêu hoặc công việc bằng ngôn ngữ tự nhiên. PairNext sẽ đề xuất
          bản nháp — <b>bạn luôn là người xác nhận cuối cùng</b>.
        </p>
        <textarea
          className="v2hero-in"
          aria-label="Mục tiêu hoặc công việc"
          placeholder="Ví dụ: Xây dựng sản phẩm EA giao dịch XAUUSD để bán trên MQL5 Market. Nghiên cứu chiến lược, phát triển, backtest, tối ưu và chuẩn bị tài liệu bán hàng…"
          value={goal}
          maxLength={GOAL_MAX}
          rows={4}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void analyze();
          }}
        />
        <div className="v2hero-actions">
          <button
            className="v2btn primary"
            onClick={() => void analyze()}
            disabled={busy || goal.trim() === ""}
          >
            {busy ? "Đang phân tích…" : "Phân tích yêu cầu →"}
          </button>
          <button
            className="v2btn"
            onClick={() => void analyze(true)}
            disabled={busy || goal.trim() === ""}
            title="Bản nháp trực tiếp từ văn bản — không cần phân tích AI"
          >
            Tạo thủ công
          </button>
        </div>
      </div>

      {err ? (
        <ErrorState
          detail={`Không phân tích được — ${err.detail}`}
          code={err.code}
          onRetry={() => void analyze()}
        />
      ) : null}

      {resp && draft ? (
        <div className="draftwrap">
          <div className="draftmain">
            <div className="drcard">
              <div className="drcard-h">
                <h2>Bản nháp</h2>
                {resp.status === "analyzed" ? (
                  <span className="sbadge t-purple">được đề xuất bởi AI — không phải quyết định</span>
                ) : (
                  <span className="sbadge t-unknown">
                    {resp.status === "unavailable"
                      ? `phân tích AI không khả dụng — nháp thủ công`
                      : "phân tích AI đang tắt — nháp thủ công"}
                  </span>
                )}
              </div>
              {resp.unavailable_reason ? (
                <div className="trunc">analysis unavailable: {resp.unavailable_reason}</div>
              ) : null}

              <div className="drf">
                <div className="drf-row">
                  <label htmlFor="dr-title">
                    Tiêu đề <ProvTag p={draft.titleProv} />
                  </label>
                  <input
                    id="dr-title"
                    value={draft.title}
                    onChange={(e) =>
                      setDraft({ ...draft, title: e.target.value, titleProv: "edited" })
                    }
                  />
                </div>
                <div className="drf-row">
                  <label htmlFor="dr-stmt">
                    Mục tiêu / công việc <ProvTag p={draft.statementProv} />
                  </label>
                  <textarea
                    id="dr-stmt"
                    rows={4}
                    value={draft.statement}
                    onChange={(e) =>
                      setDraft({ ...draft, statement: e.target.value, statementProv: "edited" })
                    }
                  />
                </div>

                <div className="drf-chips">
                  <div className="drf-chip">
                    <div className="ck">Loại đề xuất</div>
                    <div className="cv">
                      <span className="sbadge t-info">
                        {kind === "objective" ? "Objective" : "Mission"}
                      </span>
                      <span className="hint">
                        {kind === resp.draft.suggested_kind ? "gợi ý của hệ thống" : "bạn đã đổi"}
                      </span>
                    </div>
                  </div>
                  <div className="drf-chip">
                    <div className="ck">
                      Ngân sách (USD) <ProvTag p={draft.budgetProv} />
                    </div>
                    <input
                      aria-label="Ngân sách trần USD"
                      inputMode="decimal"
                      placeholder="chưa đặt"
                      value={draft.budgetUsd}
                      onChange={(e) =>
                        setDraft({ ...draft, budgetUsd: e.target.value, budgetProv: "edited" })
                      }
                    />
                    {budgetInvalid ? (
                      <div className="hint" style={{ color: "var(--danger)" }}>
                        Nhập số USD hợp lệ hoặc để trống — ví dụ: 20
                      </div>
                    ) : resp.draft.budget_hint.value ? (
                      <div className="hint">từ văn bản: “{resp.draft.budget_hint.value}”</div>
                    ) : null}
                  </div>
                  <div className="drf-chip">
                    <div className="ck">
                      Thời hạn <ProvTag p={draft.deadlineProv} />
                    </div>
                    <input
                      aria-label="Thời hạn"
                      type="date"
                      value={draft.deadline}
                      onChange={(e) =>
                        setDraft({ ...draft, deadline: e.target.value, deadlineProv: "edited" })
                      }
                    />
                  </div>
                </div>

                <h3 className="drh">
                  KPI đề xuất
                  <span className="hint"> — chỉ từ văn bản/phân tích; chỉnh sửa thoải mái</span>
                </h3>
                {draft.kpis.length === 0 ? (
                  <div className="hint drpad">Chưa có KPI nào — thêm nếu muốn theo dõi định lượng.</div>
                ) : (
                  <div className="kpicards">
                    {draft.kpis.map((k, i) => (
                      <div className="kpicard" key={i}>
                        <input
                          aria-label={`KPI ${i + 1} tên`}
                          value={k.name}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              kpis: draft.kpis.map((x, j) =>
                                j === i ? { ...x, name: e.target.value, prov: "edited" } : x,
                              ),
                            })
                          }
                        />
                        <div className="kpinum">
                          <span>≥</span>
                          <input
                            aria-label={`KPI ${i + 1} mục tiêu`}
                            inputMode="decimal"
                            value={k.target}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                kpis: draft.kpis.map((x, j) =>
                                  j === i ? { ...x, target: e.target.value, prov: "edited" } : x,
                                ),
                              })
                            }
                          />
                          <input
                            aria-label={`KPI ${i + 1} đơn vị`}
                            placeholder="đơn vị"
                            value={k.unit}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                kpis: draft.kpis.map((x, j) =>
                                  j === i ? { ...x, unit: e.target.value, prov: "edited" } : x,
                                ),
                              })
                            }
                          />
                        </div>
                        <div className="kpimeta">
                          <ProvTag p={k.prov} />
                          <button
                            className="lnkbtn"
                            onClick={() =>
                              setDraft({ ...draft, kpis: draft.kpis.filter((_, j) => j !== i) })
                            }
                          >
                            xoá
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  className="lnkbtn"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      kpis: [...draft.kpis, { name: "", target: "", unit: "", prov: "edited" }],
                    })
                  }
                >
                  + Thêm KPI
                </button>
                {kpiTargetInvalid ? (
                  <div className="hint" style={{ color: "var(--danger)" }}>
                    Mỗi KPI có tên cần một mục tiêu số — hoặc xoá KPI đó.
                  </div>
                ) : null}

                {draft.hardConstraints.length || draft.successConditions.length ? (
                  <div className="grid2">
                    {draft.hardConstraints.length ? (
                      <div>
                        <h3 className="drh">Ràng buộc cứng</h3>
                        {draft.hardConstraints.map((c, i) => (
                          <div className="conrow" key={i}>
                            <input
                              aria-label={`Ràng buộc ${i + 1}`}
                              value={c.text}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  hardConstraints: draft.hardConstraints.map((x, j) =>
                                    j === i ? { ...x, text: e.target.value, prov: "edited" } : x,
                                  ),
                                })
                              }
                            />
                            <button
                              className="lnkbtn"
                              aria-label={`xoá ràng buộc ${i + 1}`}
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  hardConstraints: draft.hardConstraints.filter((_, j) => j !== i),
                                })
                              }
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {draft.successConditions.length ? (
                      <div>
                        <h3 className="drh">Điều kiện thành công</h3>
                        {draft.successConditions.map((c, i) => (
                          <div className="conrow" key={i}>
                            <input
                              aria-label={`Điều kiện ${i + 1}`}
                              value={c.text}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  successConditions: draft.successConditions.map((x, j) =>
                                    j === i ? { ...x, text: e.target.value, prov: "edited" } : x,
                                  ),
                                })
                              }
                            />
                            <button
                              className="lnkbtn"
                              aria-label={`xoá điều kiện ${i + 1}`}
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  successConditions: draft.successConditions.filter(
                                    (_, j) => j !== i,
                                  ),
                                })
                              }
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {draft.workstreams.length ? (
                  <>
                    <h3 className="drh">
                      Kế hoạch triển khai sơ bộ
                      <span className="hint"> — gợi ý, sẽ thành công việc sau khi xác nhận</span>
                    </h3>
                    <ol className="wsstep">
                      {draft.workstreams.map((w, i) => (
                        <li key={i}>
                          <span className="wsn">{i + 1}</span>
                          <span>{w.text}</span>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : null}
              </div>
            </div>

            <div className="dractions">
              <div className="kindtoggle" role="radiogroup" aria-label="Loại">
                <button
                  role="radio"
                  aria-checked={kind === "mission"}
                  className={kind === "mission" ? "on" : ""}
                  onClick={() => setKind("mission")}
                >
                  Mission — một công việc
                </button>
                <button
                  role="radio"
                  aria-checked={kind === "objective"}
                  className={kind === "objective" ? "on" : ""}
                  onClick={() => setKind("objective")}
                >
                  Objective — mục tiêu kinh doanh
                </button>
              </div>
              <div className="actrow">
                {kind === "objective" ? (
                  <button
                    className="v2btn primary"
                    disabled={!canConfirmObjective}
                    title={
                      bizDrift
                        ? "Business đã đổi sau khi phân tích — phân tích lại để gắn đúng phạm vi"
                        : budgetInvalid || kpiTargetInvalid
                          ? "Sửa giá trị số chưa hợp lệ (hoặc để trống)"
                          : biz
                            ? ""
                            : "Chọn business trước (góc trái sidebar)"
                    }
                    onClick={() => setConfirmOpen(true)}
                  >
                    Tạo Objective →
                  </button>
                ) : (
                  <button className="v2btn primary" onClick={goMission}>
                    Tiếp tục — xem trước kế hoạch Mission →
                  </button>
                )}
                <button
                  className="v2btn"
                  onClick={() => {
                    setResp(null);
                    setDraft(null);
                  }}
                >
                  Hủy
                </button>
              </div>
              {bizDrift ? (
                <div className="hint" style={{ marginTop: 8, color: "var(--danger)" }}>
                  Business đã đổi từ <code>{analyzedBiz ?? "—"}</code> sang{" "}
                  <code>{biz || "—"}</code> — bấm “Phân tích yêu cầu” lại để gắn đúng phạm vi.
                </div>
              ) : !biz && kind === "objective" ? (
                <div className="hint" style={{ marginTop: 8 }}>
                  Chọn business ở góc trái sidebar để tạo Objective.
                </div>
              ) : null}
            </div>
          </div>

          <aside className="draftside">
            <div className="drcard">
              <h2>PairNext hiểu yêu cầu như sau</h2>
              <div className="sideg">
                <div className="sideh ok">✓ Đã hiểu rõ ({explicitItems.length})</div>
                {explicitItems.slice(0, 6).map((i: IntakeItem) => (
                  <div className="siderow" key={i.id}>{i.statement}</div>
                ))}
                {!explicitItems.length ? <div className="hint">—</div> : null}
              </div>
              <div className="sideg">
                <div className="sideh warn">? Cần xác nhận ({resp.draft.questions.length})</div>
                {resp.draft.questions.map((q) => (
                  <div className="siderow q" key={q.item_id}>
                    {q.statement}
                    {q.alternatives.length ? (
                      <div className="hint">vd: {q.alternatives.join(" · ")}</div>
                    ) : null}
                  </div>
                ))}
                {!resp.draft.questions.length ? <div className="hint">—</div> : null}
              </div>
              <div className="sideg">
                <div className="sideh info">＋ Đề xuất bổ sung ({inferredItems.length})</div>
                {inferredItems.slice(0, 6).map((i: IntakeItem) => (
                  <div className="siderow" key={i.id}>{i.statement}</div>
                ))}
                {!inferredItems.length ? <div className="hint">—</div> : null}
              </div>
            </div>
            <div className="drcard">
              <h2>Quyền &amp; kiểm soát</h2>
              <ul className="govlist">
                <li>Cần owner xác nhận — chỉ tạo Objective/Mission sau khi bạn bấm xác nhận.</li>
                <li>Không tự cấp ngân sách — mọi chi phí cần owner phê duyệt.</li>
                <li>AI suy luận không phải authority — bản nháp chỉ là đề xuất, bạn là người quyết định.</li>
                <li>
                  {resp.analysis_digest
                    ? `evidence: ${resp.analysis_digest.slice(0, 20)}… (${resp.mode}/${resp.status})`
                    : `mode: ${resp.mode} — không có phân tích AI`}
                </li>
              </ul>
            </div>
          </aside>
        </div>
      ) : null}

      {created ? (
        <div className="pstate" style={{ marginTop: 16 }}>
          <div className="icon">✓</div>
          <div className="t">Objective đã được tạo</div>
          <div className="d">
            <code>{created}</code> — objective canonical đã ghi vào business của bạn.
          </div>
          <button className="v2btn primary" style={{ marginTop: 12 }}
            onClick={() => nav(`/app/objectives/${created}`)}>
            Mở Objective →
          </button>
        </div>
      ) : null}

      {!resp && !busy && !err && !created ? (
        <EmptyState
          title="Nhập mục tiêu ở trên để bắt đầu"
          detail="PairNext sẽ phân tích và đề xuất bản nháp Objective hoặc Mission. Bạn xem lại, chỉnh sửa, rồi xác nhận — hệ thống không bao giờ tự tạo quyết định thay bạn."
        />
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="Tạo Objective"
        body={`Tạo Objective "${draft?.title ?? ""}" trong business ${biz}? Bản nháp sẽ trở thành objective canonical — các KPI/ràng buộc bạn để trống sẽ không được ghi.`}
        confirmLabel="Tạo Objective"
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void confirmObjective()}
      />
    </div>
  );
}

function isUnresolvedItem(i: IntakeItem): boolean {
  return (
    i.authority === "UNRESOLVED" ||
    i.category === "missing_information" ||
    i.category === "ambiguity" ||
    i.category === "conflict"
  );
}
