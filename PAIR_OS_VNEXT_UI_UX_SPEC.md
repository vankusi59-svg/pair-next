# PAIR OS vNext — UI/UX Specification v1

Status: DRAFT — chốt user flow + wireframe trước khi implement.
Baseline: `main` @ `6a642ad` (post-release V1.0.0 + Gemini default route).

## §0. Mục đích

Mission Control hiện là một UI server-rendered tối giản (`UI_HTML` trong `mission-control-server.ts`). Spec này định nghĩa trải nghiệm operator-facing đầy đủ: dashboard, mission workspace, provider/model visibility, observability, polish production — triển khai theo phase trên branch riêng, **không đụng governed runtime hay routing authority**.

## §1. Nguyên tắc thiết kế (không đàm phán)

1. **UI là observation + operator boundary.** UI không bao giờ tự ghi DB, tự route task, tự quyết định recovery, hay tự chọn executor/model. Mọi mutation đi qua canonical Mission Control services (`mission-control.ts`) — giữ nguyên.
2. **Fail-closed được hiển thị trung thực.** Khi hệ thống từ chối (không executor eligible, credential thiếu, approval pending), UI nói rõ *vì sao* — không giả lập, không "auto-fix" ngầm.
3. **Không bao giờ hiển thị secret.** Credential chỉ hiện `configured` / `unavailable`. Env var NAME được phép; value tuyệt đối không.
4. **Một mission, một câu chuyện.** Operator submit goal bằng ngôn ngữ tự nhiên → xem plan → theo dõi → can thiệp chỉ ở genuine boundary (approval, reconciliation, replan).
5. **Ngôn ngữ dễ hiểu.** Trạng thái kèm giải thích tiếng Việt/plain-English; mã lỗi canonical (`FAIL_CLOSED_*`) hiện nguyên nhưng luôn kèm diễn giải.

## §2. Kiến trúc

```
apps/
  mission-control-ui/          # frontend mới (Vite + React hoặc tương đương)
    src/
      components/              # design-system primitives (badge, card, table, timeline, dag)
      pages/                   # dashboard, mission-detail, mission-new, providers, observability
      hooks/                   # api client, SSE subscription, poll fallback
      styles/
src/pair/
  mission-control.ts           # canonical read models + operator actions (AUTHORITY — không đổi)
  mission-control-server.ts    # API/auth boundary duy nhất (thêm endpoints §4, thêm SSE)
```

Ràng buộc đã kiểm chứng trong code:

- `mission-control-server.ts` là API/auth boundary: GET → canonical projections; POST → operator-id bắt buộc (`403 FAIL_CLOSED_OPERATOR_ID_REQUIRED` khi thiếu).
- Read models sẵn có: `/api/health`, `/api/metrics`, `/api/missions`, `/api/missions/:id`, `/dag`, `/timeline`, `/evidence`, `/api/routing`, `/api/recovery`, `/api/approvals`, `/api/experience`, `/api/selfmod`.
- Mutations sẵn có: `POST /api/missions` (submit goal), `pause|resume|cancel|acknowledge|reconcile`, `approve|deny` approvals, `approve|reject` promotions, `POST /api/tick`.
- Frontend đặt trong `apps/` → cần thêm `"apps/*"` vào `pnpm-workspace.yaml`.
- Server chỉ phục vụ API; SPA build tĩnh có thể serve chung hoặc dev-proxy — chọn serve-tĩnh-từ-server cho production đơn giản.

## §3. Information architecture

| Trang | Route UI | Nguồn dữ liệu (đã có / cần thêm) |
|---|---|---|
| Dashboard | `/` | missions, health, metrics, routing (có) + providers summary (§4.2) |
| Mission detail | `/missions/:id` | detail, dag, timeline, evidence (có đủ) |
| Mission workspace | `/missions/new` | submit + plan preview (§4.3) |
| Approvals inbox | `/approvals` | approvals + approve/deny (có) |
| Providers & Models | `/providers` | **mới** (§4.2) |
| Observability | `/observability` | routing + recovery + experience + selfmod (có) + live stream (§4.1) |

## §4. Backend additions (việc backend, chưa có)

### §4.1 Live event stream — `GET /api/events` (SSE)

Server hiện chỉ REST. Thêm SSE endpoint stream các sự kiện canonical: mission state transition, task dispatch/collect, route decision, recovery decision, approval created/resolved, scheduled_action fired. Nguồn: poll định kỳ store/journal projection (interval ngắn, xác định) hoặc hook vào evidence append — chọn cái đơn giản hơn mà không thêm authority mới. Client fallback: poll 5s khi SSE không khả dụng. Không mutation qua stream này.

### §4.2 Provider/model/route read endpoints

- `GET /api/providers` → ProviderCatalog projection: id, state (DISCOVERED/PROBED/QUALIFIED…), credential_status (`configured|unavailable` — bool từ `envReader`, không trả tên biến lẫn giá trị... thực tế trả `credential_env` NAME là OK theo spec P6, KHÔNG trả value), discovered models count.
- `GET /api/models` → ModelEvidenceCatalog projection: canonical `family:model`, capability claims, qualification state, staleness.
- `GET /api/routes` → route registry + binding projection: mỗi route — kind, executor, qualification, health, priority, và **lý do bị loại** (`hard_rejections`/`reason_codes` đã có trong route_decision).
- `GET /api/models/:id/routable` → 13-gate projection chi tiết cho 1 model (để trang "vì sao route này được/chưa được chọn").

Tất cả read-only; data từ canonical catalogs, không compute mới.

### §4.3 Plan preview (submit 2 bước)

Hiện `POST /api/missions` = plan + chạy luôn. Cho "hiển thị plan trước khi chạy":

- `POST /api/missions/preview` → chạy planner, trả plan proposal (tasks, dependencies, required capabilities, resolved executors nếu có) mà KHÔNG tạo mission.
- `POST /api/missions` với `confirm_plan: {digest}` → chỉ dispatch khi plan digest khớp preview (chống TOCTOU: plan hiển thị phải là plan chạy).
- Mission state mới có thể cần: `PLANNED_AWAITING_CONFIRMATION` hoặc tái dùng approval gate — quyết định tại implement, phải giữ fail-closed (confirm sai digest → reject).

### §4.4 Operator identity model

Hiện operator = header `x-operator-id` tự khai báo. Production UI cần quy ước rõ: dev-mode = operator nhập ID một lần lưu localStorage gửi kèm header; sau này có thể thay bằng session thật — spec này chỉ chốt: **mọi mutation ghi kèm operator id vào audit trail** (đã có), UI hiển thị "đang thao tác dưới tên X".

## §5. User flows cốt lõi

### F1 — Submit + theo dõi mission
`/missions/new` → nhập goal tự nhiên → `POST /preview` → màn hình plan (danh sách task + DAG + executor dự kiến + capabilities) → Confirm → mission `RUNNING` → dashboard/mission-detail cập nhật live (SSE) → `COMPLETED`/`FAILED`/boundary.

### F2 — Boundary intervention
Mission vào `WAITING_APPROVAL` hoặc reconciliation → banner nổi + inbox `/approvals` → xem scope digest + lý do → Approve/Deny → mission tiếp tục hoặc fail-closed rõ ràng.

### F3 — Pause/resume/cancel/replan
Mission detail action bar: Pause ↔ Resume, Cancel (confirm modal nêu side-effect policy: reconciliation barrier, `UNKNOWN_SIDE_EFFECT_STATE`), Replan (hiện plan mới, qua §4.3 confirm).

### F4 — "Vì sao chọn model/executor này?"
Mission detail → routing decision → `/providers` hoặc `/observability` → thấy route chính, route dự phòng đã qualify, lý do route khác bị loại (ví dụ `MISSING_CAPABILITIES:SHELL_EXECUTION`, `DSH_CREDENTIAL_NOT_RESOLVABLE`). Đây là câu trả lời trực quan cho câu hỏi failover.

### F5 — Recovery visibility
Task fail → recovery decision explorer: failure class, decision (RE_ROUTE/RETRY/ABORT/…), target route mới, budget còn lại — toàn bộ đã có trong `/api/recovery`.

## §6. State & visual language

Trạng thái mission chuẩn (canonical): `CREATED PLANNING READY RUNNING PAUSED REPLANNING WAITING_APPROVAL COMPLETED FAILED CANCELLED ABORTED` — badge màu:

- RUNNING=xanh dương, COMPLETED=xanh lá, FAILED/ABORTED=đỏ, PAUSED=vàng, WAITING_APPROVAL=cam nhấp nháy nhẹ, PLANNING/READY=xám.
- Mỗi badge kèm tooltip giải thích 1 câu + link tới timeline position tương ứng.
- Empty/loading/error state chuẩn hóa: empty → CTA "Tạo mission đầu tiên"; error → canonical error code + diễn giải + retry.

## §7. Phase plan

| Phase | Nội dung | Phụ thuộc backend |
|---|---|---|
| UI-1 | Shell app, dashboard, mission list, mission detail (timeline+DAG+artifacts), state badges | — |
| UI-2 | Mission workspace: submit, plan preview (§4.3), pause/resume/cancel, approval actions | §4.3, §4.4 |
| UI-3 | Providers/Models/Routes pages + "vì sao chọn route này" | §4.2 |
| UI-4 | Observability: event stream, decision explorers, audit trail, export evidence | §4.1 |
| UI-5 | Polish: responsive, dark/light, a11y keyboard, search/filter/sort, toast, E2E Playwright | — |

Ưu tiên: UI-1 → UI-2 → UI-3 → UI-4 → UI-5. Mỗi phase = 1 branch riêng (`feat/ui-1-*` …) push pair-next, không squash vào release tag.

## §8. Acceptance criteria chung

- UI không có code path nào ghi thẳng DB/store — lint-grep được (không import `store.ts` trong `apps/`).
- Mọi mutation test cần operator id; thiếu → 403 được hiển thị.
- Secret-scan trên mọi response API/UI: 0 secret value.
- E2E: submit→plan→confirm→pause→resume→complete + deny-approval→fail-closed hiển thị đúng.

## §9. Non-goals V1

- Không auth multi-user/phân quyền role.
- Không cho UI chỉnh routing authority, không "override" fail-closed.
- Không embedded terminal/log streaming full-fidelity (artifact viewer đủ).
- Không mobile-native; responsive desktop/tablet thôi.
