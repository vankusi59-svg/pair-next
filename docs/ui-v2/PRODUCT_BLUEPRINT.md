# PRODUCT_BLUEPRINT — PAIRNEXT V2 Owner-First Experience

**Branch:** `ui-v2-owner-experience` · **BASE:** `ab0fccf79b2ac5ed045e948a0402ecbaa889c439`
**Mission:** `pairnext_v2_handoff/DEVIN_MASTER_MISSION.md` — full V2 UX + governed NL intake.
**Design refs:** `design-references/01..03` — guidance only; no mockup value ships as data.

## 1. Authority model (unchanged)

V2 is a presentation + intake layer over existing canonical seams:

| Stage | Seam | Authority |
|---|---|---|
| NL analyze | `POST /api/v1/intake/draft` (new, read-only advisory) | `semanticMode()` env; ONE bounded provider call; analysis_digest provenance; nothing persisted canonical |
| Objective commit | `POST /api/vnext/objectives` (existing) | Canonical service validation, `dedup_key` replay guard, `canonicalOperatorActor` owner identity |
| Mission path | `POST /api/missions/preview` → `POST /api/missions` (existing) | extractGoalContract, plan validation, GUARDED ambiguity approval, digest re-check on confirm |
| Approvals | `/api/approvals/*`, `/api/goal-intent/approve` (existing) | Untouched |

Semantic interpretation is **advisory evidence only**. The draft is a non-authoritative editable proposal: every field carries a provenance tag (`explicit` from the user's text · `suggested` model-inferred · `unresolved`). The server-side derivation (`deriveIntakeDraft`) NEVER invents KPIs, numbers, deadlines, currencies or permissions — unresolved fields stay unresolved. Provider OFF/unavailable/malformed → honest `unavailable`/`off` state + the governed manual workflow — never a silent enable, never a fabricated interpretation.

Owner/Advanced mode is a **presentation toggle** (`pair.owner_mode` localStorage) — same routes, same API, same authorization; it only collapses the advanced nav group.

## 2. Sitemap

```
Owner nav (VN-first):
  Tổng quan        /app/home            (new — dashboard + NL hero entry; /app index redirects here)
  Mục tiêu         /app/objectives      (existing list; Objective intake happens at /app/new via the kind toggle)
  Công việc        /app/missions        (existing Missions; relabeled)
  Phê duyệt        /app/inbox           (existing Owner Inbox; relabeled)
  Nhân sự AI       /app/workforce       (existing; /app/workforce/admin reachable contextually)

  Nâng cao (advanced group — collapsible in Owner mode, always reachable):
    /app/new?mode=advanced or any — /app/company (cockpit), /app/ceo, /app/chat,
    /app/system/* (business-admin, providers, observability, schedules, cost, settings)

Intake:
  /app/new         — unified NL entry ("Bạn muốn PairNext thực hiện điều gì?")
                     → draft review → confirm: Objective commit | Mission preview handoff
  /app/missions/new — manual mission path (unchanged governed flow, accepts ?goal= prefill)

Objective detail (existing route, tabbed IA):
  /app/objectives/:id — Tổng quan | Kế hoạch | Thực thi | Kết quả | Nâng cao
  /app/objectives/:id/reviews (unchanged deep link)
```

Legacy `/` redirects preserved (`OptInRedirect`); `/app` index now lands on `/app/home`. Every old route stays reachable — nothing is hidden behind an unreachable path.

## 3. Primary journeys

**J1 — NL Objective (the priority flow):**
Tổng quan hero → type VN/EN → `POST /api/v1/intake/draft` → editable draft card (title, statement, objective-vs-mission suggestion w/ override, KPI proposals, deadline, ceiling, hard constraints, workstreams — each tagged) → owner edits → explicit confirm → `POST /api/vnext/objectives` (dedup_key = client UUID) → navigate to objective detail.

**J2 — NL Mission:** same entry; operator picks Mission (or draft analysis suggests it) → handoff to `/app/missions/new?goal=…` — existing preview/confirm + GUARDED approval flow untouched. Never "execute from typing".

**J3 — Monitor:** dashboard status cards (canonical counts only, each linking to its source list) → objective detail tabs → mission detail → evidence.

**J4 — Decide:** Inbox = single approval surface (unchanged canonical approve/deny/goal-intent-approve).

## 4. Component & copy rules

- VN-first copy on all new surfaces + nav; EN subtitles where helpful. Technical codes rendered inside expandable raw/evidence blocks, not as primary copy.
- Reuse the token system (`.appshell` vars, `[data-theme]` light/dark — both must render); accent shifts toward the mockup violet-blue via token values only. Components stay semantic-tokened; no raw hues.
- Reuse existing primitives: `.stat`, `.ecard`, `.sbadge`, `.pstate`, `.cdlg`, `.ftab`, `.meter`, ConfirmDialog, StatusBadge, states.tsx (Empty/Error/Loading/Unknown).
- Every count/percent either links to canonical evidence or renders `—`/unknown. No derived progress %, no ETA unless the objective exposes canonical completion evidence.
- Responsive: desktop sidebar ≥1200, icon rail 768–1199, bottom tab bar + drawer <768 (existing AppShell mechanics kept; new pages grid-collapse under 800px).
- A11y: labels on inputs, focus-visible outline, modal focus management (existing pattern), WCAG 2.2 AA contrast targets — report residual exceptions honestly.

## 5. Source-of-truth map

| UI element | Canonical source |
|---|---|
| Objectives / counts | `GET /api/vnext/objectives?business_id=` |
| Objective detail + KPIs | `GET /api/vnext/objectives/:id` |
| Cockpit/relations | `objectiveCockpit`, `businessCompany` |
| Missions | `GET /api/missions`, `:id` + `/timeline` |
| Approvals badge/list | `GET /api/approvals` + `targets_met_pending` |
| Work items/agents | `GET /api/work-items`, `/api/org-agents`, business board |
| Intake draft | `POST /api/v1/intake/draft` (advisory) |
| Objective create | `POST /api/vnext/objectives` |
| Mission preview/confirm | `POST /api/missions/preview`, `POST /api/missions` |

## 6. Out of scope

Planner/runtime/DB/auth changes beyond the one advisory endpoint; multi-tenant schema changes; P19 features; pixel-perfect mockup parity; translating every legacy string in one pass (new surfaces are VN-first; legacy pages keep their copy until replaced).
