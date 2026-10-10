# D — Screen Specifications & Wireframes

Wireframes are structural intent, not pixel spec. Token names (C.1), state
vocabulary (C.5) and badges are normative. `⟡` = interactive,
`●` = badge/count, `◐` = proof chip.

## D.1 App shell (all new screens)

```
DESKTOP ≥1200
┌──────────┬──────────────────────────────────────────────────────────────┐
│ PAIR ▮   │ topbar: ‹crumb›                    [search]   [op ▸]  [☾/☀]  │
│ CO｜biz ▼ │──────────────────────────────────────────────────────────────│
│ Overview │                                                              │
│  Cockpit │                         CONTENT                              │
│  Inbox ●3│                                                              │
│ Business │                                                              │
│  Object..│                                                              │
│  CEO     │                                                              │
│  Workfo..│                                                              │
│ Ops      │                                                              │
│  Missions│                                                              │
│  Chat    │                                                              │
│ System ▸ │                                                              │
│ [op:waza]│                                                              │
└──────────┴──────────────────────────────────────────────────────────────┘

MOBILE <768
┌──────────────────────────────┐
│ PAIR CO      [biz ▼]    [☰]  │
│──────────────────────────────│
│           CONTENT            │
│──────────────────────────────│
│ Cockpit│Inbox●│Objs│Miss│More│   ← bottom tab bar, ≥40px targets
└──────────────────────────────┘
```

## D.2 Company Cockpit — `/app/company`

Purpose: the owner's answer to "how is the company doing and what needs me".

```
DESKTOP
┌ Company Cockpit ───────────────────────────── [business: Acme ▼] ─┐
│ ┌─stat──┐┌─stat──┐┌─stat──┐┌─stat──┐┌─stat──┐                     │
│ │Obj  5 ││MET  2 ││CAND 1 ││ACH  1 ││$spend │                     │
│ └───────┘└───────┘└───────┘└───────┘└───────┘                     │
│ ┌ Needs you ●3 ────────────────────────────────────────────────┐ │
│ │ ⟡ OBJ-7  TARGET_MET_CANDIDATE  "all KPIs met — sign off"      │ │
│ │ ⟡ OBJ-2  approval pending     mission MSN_..9 asks for repo    │ │
│ │ ⟡ OBJ-4  policy HALTED        "budget cap hit"                │ │
│ └───────────────────────────────────────────────────────────────┘
│ ┌ Objectives ───────────────────────────────────────────[→ all]─┐│
│ │ EntityCard ×N:                                                ││
│ │ ┌───────────────────────────────────────────────────────────┐ ││
│ │ │ OBJ-7  Launch Q4 campaign            ●RUNNING       →      │ ││
│ │ │ KPI ▓▓▓▓▓▓▓░░  3/4 MET  ◐proven      budget ▓▓░░ 41%       │ ││
│ │ │ deadline 12/31 · workstreams 2/5 done · last review CAND   │ ││
│ │ └───────────────────────────────────────────────────────────┘ ││
│ └───────────────────────────────────────────────────────────────┘│
│ ┌ Activity (scoped) ────────────────────────────────────────────┐│
│ │ activity feed ONLY when a business-scoped endpoint exists     ││
│ │ (API_MISSING — see E.6); until then: recent reviews list.     ││
│ └───────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘

MOBILE
┌ Company Cockpit ───────────┐
│ [Acme ▼]                   │
│ ┌ Needs you ●3 ──────────┐ │
│ │ ⟡ OBJ-7 CANDIDATE …    │ │
│ └──────────────────────────┘
│ OBJ-7 Launch Q4   ●RUNNING │
│ KPI ▓▓▓▓▓▓░ 3/4  ◐proven   │
│ ── next card ───────────── │
```

Acceptance: stat chips = exact company counts (`objectives_owned`,
`targets_met_pending`, MET/CANDIDATE/ACHIEVED bands); cards show
`canonically_proven` chips — an unproven KPI never renders "MET"; zero-owned
state renders DeniedState (403 contract), not an empty dashboard.

## D.3 Objective Detail — `/app/objectives/:id`

```
DESKTOP
┌ ‹Objectives / OBJ-7 ─ Launch Q4 campaign ──────── ●RUNNING ──────┐
│ statement · deadline 12/31 · owner op:waza · terms v3            │
│ ┌ KPI ────────────┐ ┌ Budget ──────────┐ ┌ Lifecycle ─────────┐ │
│ │ kpi1 ▓▓▓▓ 100/100│ │ ▓▓░░ 41% $4.1k   │ │ RUNNING             │ │
│ │  MET ◐proven    │ │ ◐proven          │ │ all_met: true       │ │
│ │ kpi2 ▓▓░░ 60/100│ │ ceiling $10k     │ │ review: CANDIDATE   │ │
│ │  GAP ◐proven    │ │                  │ │ owner_action: ●YES  │ │
│ └─────────────────┘ └──────────────────┘ └─────────────────────┘ │
│ ┌ Owner actions ⟡ ─────────────────────────────────────────────┐ │
│ │ [Run CEO pass] [Auto policy ▸] [Accept as ACHIEVED ⟡A2]      │ │
│ │ (A2 buttons disabled with gloss until owner routes ship)     │ │
│ └───────────────────────────────────────────────────────────────┘
│ ┌ Plan & workstreams (CEO) ─────────────────────────────────────┐
│ │ ws:content  ●DONE    ◐proven → DL_..3 → MSN_..9 ●COMPLETED    │ │
│ │ ws:distrib  ●IN_PROGRESS          → DL_..7 → MSN_..4 ●RUNNING │ │
│ │ ws:legal    ●BACKLOG  (no allocation)                         │ │
│ └───────────────────────────────────────────────────────────────┘
│ ┌ Artifacts (verified only ◐) ───┐ ┌ Reviews ───────────────────┐│
│ │ logo.png  MSN_..9 ◐verified   │ │ CANDIDATE "all met"  10/02  ││
│ │ +2 dropped unverifiable       │ │ WAIT "evidence gap"  09/28  ││
│ └───────────────────────────────┘ │ [view all → reviews page]   ││
│                                    └────────────────────────────┘│
│ auto_policy: ENABLED v2 exp 11/01 ◐   auto_driver: status —      │
└──────────────────────────────────────────────────────────────────┘
```

Edge renders (all spec'd, none invented):
- `expiry_pending:true` → warn chip "policy expired — awaiting canonical commit".
- `observation_error` → UnverifiedPanel replacing workstream/KPI-verified claims; raw KPI values still shown as *claims* (labeled), never as MET.
- `artifacts_dropped_unverified > 0` → counter chip, no listing.
- KPI MET while a workstream is still BACKLOG/IN_PROGRESS → lifecycle band shows "MET — workstreams still converging" (info, not error).
- Pre-binding objective → workstream section EmptyState "no canonical plan yet".

Mobile: sections stack in this order — lifecycle → KPI → budget → needs-action →
workstreams → artifacts → reviews → policy. Table→card collapse per C.3.

## D.4 CEO Workspace — `/app/ceo`

```
┌ CEO Workspace ──────────────────────────────────────────────────┐
│ Objective selector [OBJ-7 Launch Q4 ▼]      last pass: 10/02 09:14│
│ ┌ Latest pass outcome ─────────┐ ┌ Strategy ────────────────────┐│
│ │ outcome: DISPATCHED_MISSION  │ │ revision SR_..2 · 5 workstreams│
│ │ mission: MSN_..4 → link      │ │ decision CD_..8             ││
│ └───────────────────────────────┘ └──────────────────────────────┘│
│ ┌ Decisions & reviews ───────────────────────────────────────────┐
│ │ timeline: review rows newest-first (from /reviews endpoint),   │
│ │ each expandable → observation digest, recommendation, pins.    │
│ └─────────────────────────────────────────────────────────────────┘
└──────────────────────────────────────────────────────────────────┘
```

Honest framing: the workspace *explains* the autonomous layer — it is not a
CEO control panel. `runCeoCycle` button keeps existing semantics (manual pass,
owner-scoped). API_MISSING marker: a dedicated CEO-decision browse endpoint
doesn't exist; decisions render only as far as review rows carry them.

## D.5 AI Workforce — `/app/workforce`

```
┌ AI Workforce ───────────────────────────────── [biz: Acme ▼] ────┐
│ ┌ Agents ────────────────────────────────────────────────────────┐
│ │ Ava Chen    dept:growth   contract ON   active 3   inbox 1      │
│ │ Devin Sol   dept:eng      contract ON   active 5   inbox 0      │
│ │ (rows from /api/org-agents + /api/businesses/:id/work-graph)    │
│ └────────────────────────────────────────────────────────────────┘
│ ┌ Agent detail (drawer/route) ────────────────────────────────────┐
│ │ contract v4 · effective-policy summary · current work items ·   │
│ │ recent messages (inbox) · outcomes                              │
│ └─────────────────────────────────────────────────────────────────┘
└────────────────────────────────────────────��─────────────────────┘
```

All API_READY. Contract/effective-policy detail keeps authority semantics:
pause/resume/terminate actions reuse existing POSTs inside ConfirmDialog.

## D.6 Owner Control Center — `/app/inbox`

```
┌ Owner Inbox ─────────────────────────────── filters: all|approvals│
│ reviews|halts ────────────────────────────────────────────────────┐
│ ┌ REVIEWS (objective sign-offs) ─────────────────────────────────┐
│ │ OBJ-7 TARGET_MET_CANDIDATE  "all KPIs met"  pins fresh ◐        │
│ │   [open objective]   [Accept ACHIEVED ⟡A2]  [Request changes ⟡A2]│
│ └─────────────────────────────────────────────────────────────────┘
│ ┌ APPROVALS (permissions) ────────────────────────────────────────┐
│ │ MSN_..2 asks: shell.write on ws:repo  [approve] [deny]          │
│ └─────────────────────────────────────────────────────────────────┘
│ ┌ HALTS / policy ─────────────────────────────────────────────────┐
│ │ OBJ-4 auto-policy HALTED — "budget cap hit" [resume ⟡policy]    │
│ └─────────────────────────────────────────────────────────────────┘
└──────────────────────────────────────────────────────────────────┘
```

Pin-staleness rule (R3-F2 contract): a CANDIDATE whose pins no longer match
the objective shows as **history**, never as pending — the inbox only counts
`owner_action_pending` rows the API already filtered.

## D.7 Mission Operations — `/app/missions*`

Ported verbatim: list (new), detail (DAG, timeline, evidence, files, actions).
New links: workstream→mission rows deep-link here; mission detail gains a
"← Objective" backlink when `bound_open_id`/lineage proves one (lookup via
cockpit, not new authority).

## D.8 Chat — `/app/chat`

Ported verbatim (turn → proposal → draft confirm/reject golden path).

## D.9 System & Settings — `/app/system/*`

- **providers**: ported `Providers.tsx` (providers/models/routes cards).
- **observability**: ported `Observability.tsx` + SSE stream (global stream
  stays HERE — a technical surface, never the company feed).
- **schedules**: ported `Schedules.tsx`.
- **cost**: new thin page over `cost` + cost-policies/profiles reads
  (controls are API_READY but out of B-scope; mark buttons A2+).
- **settings**: token + operator-id session editor (replaces `window.prompt`
  UX), theme, legacy-UI link. No new auth semantics.
