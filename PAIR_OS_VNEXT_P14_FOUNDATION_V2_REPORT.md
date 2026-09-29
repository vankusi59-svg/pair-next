# PAIR OS — VNEXT P14 FOUNDATION V2 REPORT

## Classification

**`P14_FOUNDATION_V2_PENDING_AUDIT`**

**PR #8 (`8982f17`, `P14_PROVENANCE_REBASELINED_PENDING_AUDIT`) is reference
material only — it was NOT merged and was NOT used as the implementation
base.** This build is a fresh, foundation-only implementation on a new
branch grown directly from the canonical base
`a38be24b8bb240570d0cce322766ece1bccceab9`.

**P14 V2 is the foundation layer only — it is NOT the full P14
autonomous workforce. No P15/P16 implementation has started.**

## 1. Canonical binding authority

Authority chain: `WorkItem → work_open_binding → bound mission →
Planner → MissionRouter → GovernedTaskGate → executors`.

`work_open_binding` is a durable row created by `BusinessLayer.openWorkItem`
**before** any mission exists:

```
{ open_id, work_item_id, business_id, project_id,
  org_agent_id, created_by,
  mission_id,                     // pinned BEFORE mission creation
  state: "INTENT" | "BOUND" | "ROLLED_BACK",
  created_at, bound_at, rolled_back_at, updated_at, version }
```

The binding **pins the `mission_id` up front**: `openWorkItem` mints
`MSN_*`, stores it in the binding (state `INTENT`), then asks
`MissionControl.startBoundMission` to create exactly that mission
(`FAIL_CLOSED_MISSION_PIN` if a different id comes back). The work-item
link write and the `INTENT→BOUND` flip commit in **one**
`PairEvidenceStore.immediate()` transaction — a crash can never leave a
linked mission with an INTENT binding or vice versa.

Mission `metadata` (`work_item_id`, `business_id`, `work_item_open_id`,
`org_agent_id`, `source`) is written purely for observability — proof
never consults it.

## 2. Public vs internal mission creation

- **`MissionControl.startMission(input)`** — the public seam used by
  `POST /api/missions`. Any `input.mission_id` field →
  `FAIL_CLOSED_MISSION_ID_PUBLIC` (HTTP 409). Callers create ordinary
  missions with ordinary metadata but can **never** pin a mission
  identity and can never create a mission that becomes canonical proof
  for a WorkItem.
- **`MissionControl.startBoundMission(input)`** — internal seam for
  `BusinessLayer` only. Requires `input.mission_id`; runs the **same**
  `startMissionInternal` pipeline (plan digest, contract pin, business
  context, secret grants, supervisor wake) with the pinned id.
- **`PairControlPlane.createMission({ mission_id })`** — internal-only
  optional pin; the version-0 `store.put` CAS insert **fails closed on
  any collision** — a reserved id can never be overwritten or claimed by
  a forged create.

## 3. Proof model (single authority)

`missionBoundToWorkItem(row, mission)` requires ALL of:

- `mission.mission_id ∈ row.mission_ids` (canonical link);
- a `work_open_binding` in state `BOUND` exists whose `mission_id`,
  `work_item_id`, and `business_id` all match;
- `binding.project_id === mission.project_id` (cross-project closure);
- the binding is exactly the one recorded on `pending_open_id`/history
  for this work item.

`boundMissionForWorkItem(row)` resolves the latest linked mission and
returns it only when the predicate holds; `proveReviewAcceptance(row)`
requires exactly one valid `WORK_REVIEW_ACCEPTED` event (old=
`REVIEW_REQUIRED`, new=`DONE`, reviewer present / same business / not the
assignee / matches the named `reviewer_agent_id`); `proveWorkItemDone`
combines bound-mission COMPLETED with review proof when
`requires_review`.

`syncWorkItem` folds terminal mission state only through this predicate —
a foreign or forged mission id triggers `quarantineWorkItem`
(`TERMINAL_PROVENANCE_CORRUPT`, idempotent `WORK_PROVENANCE_INCONSISTENT`
event) instead of any state change. `blockWorkItem`/`cancelWorkItem`
pause/cancel **only** the bound mission — a corrupt `mission_ids` entry
can never touch another item's live mission.

All authority paths fail closed on quarantined rows through
`assertWorkItemNotQuarantined` (`FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`):
`openWorkItem`, `claimWorkItem`, `assignWorkItem`, `reviewWorkItem`.

## 4. Minimal review grounding (§10)

`reviewWorkItem` is the foundation review seam — **not** the full P14
workforce review system:

- row must be `REVIEW_REQUIRED` and unquarantined;
- the `REVIEW_REQUIRED` state must be grounded: the item's **bound**
  mission must be `COMPLETED` — a fabricated `REVIEW_REQUIRED`
  quarantines the row and fails both ACCEPT and REWORK with
  `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`, emitting **no** review-decision
  evidence;
- reviewer must resolve, be same-business, `ACTIVE`, not the assignee,
  and match `reviewer_agent_id` when one is named;
- decision ∈ {`ACCEPT`→`DONE`, `REWORK`→`READY`} — strict enum,
  committed atomically with its `WORK_REVIEW_ACCEPTED` /
  `WORK_REWORK_REQUESTED` event inside `store.immediate()`.

`syncWorkItem` maps a bound `COMPLETED` mission to `REVIEW_REQUIRED`
when `requires_review`, else `DONE`. `REVIEW_REQUIRED` transitions are
restricted to `DONE | READY | BLOCKED | CANCELLED`.

## 5. Crash / recovery semantics (three binding boundaries)

| Boundary | State | Recovery (`reconcileOpenIntent`, binding-driven) |
|---|---|---|
| A — crash before mission | binding `INTENT`, pinned `mission_id`, **no mission row** | rollback to openable state + binding `ROLLED_BACK`; no dup mission, no abandoned INTENT |
| B — crash after mission | binding `INTENT` + exact pinned mission exists | adopt **only** the pinned mission — link + `BOUND` in one txn; a forged mission with identical metadata is never adopted; no second mission |
| C — post-BOUND | binding `BOUND` + row linked | fully landed → no-op; idempotent across restarts |

A binding that is missing or `ROLLED_BACK` resolves as a plain rollback —
recovery can never resurrect a dead intent or link a forged mission.
`markBindingRolledBack` covers every rollback path (catch-path +
stale-grace sweep), so no `INTENT` rows are abandoned indefinitely.

## 6. Required V2 test matrix — `src/__tests__/pair-p14-foundation.test.ts` (10 tests)

| Test | Verdict |
|---|---|
| FOUND-V2-PUBLIC-ID-PIN | `POST /api/missions` with `mission_id` → **409 `FAIL_CLOSED_MISSION_ID_PUBLIC`**; direct `startMission` pin → same; reserved id never occupied; internal `startBoundMission` still creates it |
| FOUND-V2-FORGED-METADATA | mission created through the generic API carrying perfect forged seam metadata → **zero authority**: never links, never completes, sync → `TERMINAL_PROVENANCE_CORRUPT`, assign blocked |
| FOUND-V2-CROSS-WORK | A's bound COMPLETED mission planted on B → B cannot complete; B quarantines; A unaffected |
| FOUND-V2-CROSS-BUSINESS | binding tampered to a foreign `business_id` → proof fails → quarantine |
| FOUND-V2-CROSS-PROJECT | bound mission drifted to another `project_id` → proof fails → quarantine |
| FOUND-V2-CRASH-BEFORE-MISSION | intent, no mission → rollback; `ROLLED_BACK`; zero missions |
| FOUND-V2-CRASH-AFTER-MISSION | adopt only pinned mission; forged same-open_id mission untouched; 1 `WORK_ITEM_OPEN_RECONCILED`; `BOUND` |
| FOUND-V2-RESTART-IDEMPOTENT | fresh stack on same DB: re-sweep = no-op; no dup mission/event |
| FOUND-V2-UNGROUNDED-REVIEW | fabricated `REVIEW_REQUIRED` → ACCEPT + REWORK both fail `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`; quarantined; zero review events |
| FOUND-V2-HAPPY | `openWorkItem` → binding `BOUND` with pinned mission through the governed chain (contract pin + secret grants present); COMPLETED → `DONE`; `requires_review` item → `REVIEW_REQUIRED` → ACCEPT → `DONE` + exactly one `WORK_REVIEW_ACCEPTED` |

## 7. Validation results (this branch)

| Surface | Result |
|---|---|
| Foundation V2 suite | **10/10** |
| P13 suite | 67/67 |
| P12 suite | 71/71 |
| P11 suite (7 files) | 103/103 — r1/r2 crash-orphan fixtures updated to the canonical binding shape (INTENT binding + pinned `mission_id` via `startBoundMission`) |
| P9 suite | 79/79 |
| Typecheck (`tsc --noEmit`) | clean |
| Build (`pnpm build`) | PASS |
| `pnpm audit --audit-level=high` | 0 high / 0 critical |
| Full suite — Node 22 | see CURRENT_STATE |
| Full suite — Node 20 | see CURRENT_STATE |
| `verifyIntegrity()` | clean on every suite entry |

P12 contract governance, P13 cost/secrets governance, and the single
`MissionRouter`/`GovernedTaskGate` execution path are unchanged — no
second router, dispatcher, or execution engine was introduced; the only
new authority record is `work_open_binding` inside the existing
`PairEvidenceStore.immediate()` transaction authority.

## 8. Explicitly out of scope (foundation only)

No workforce layer: no work-graph decomposition, no agent delegation, no
heartbeat/autonomous claim loop, no inbox projection, no dependency
graph — those remain P14-workforce scope and are **not** implemented
here. `reviewWorkItem` is the minimal grounding seam required by §10,
not the full review/acceptance system.
