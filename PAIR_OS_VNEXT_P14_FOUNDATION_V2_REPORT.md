# PAIR OS — VNEXT P14 FOUNDATION V2 REPORT

## Classification

**`P14_FOUNDATION_V2_REMEDIATED_R1_PENDING_AUDIT`**

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
  `BusinessLayer` only (R1: takes `binding_open_id`, loads + validates
  the canonical binding, derives the reserved mission_id FROM it, stamps
  `bound_open_id` origin proof); runs the **same** `startMissionInternal`
  pipeline (plan digest, contract pin, business context, secret grants,
  supervisor wake).
- **`PairControlPlane.createMission({ mission_id })`** — internal-only
  optional pin; the version-0 `store.put` CAS insert **fails closed on
  any collision** — a reserved id can never be overwritten or claimed by
  a forged create.

## 3. Proof model (single authority)

`missionBoundToWorkItem(row, mission)` requires ALL of (R1 §5 validator):

- `mission.mission_id ∈ row.mission_ids` (canonical link);
- `mission.bound_open_id` — the non-forgeable internal origin proof —
  resolves to a `work_open_binding` in state `BOUND`;
- the binding validates the full canonical chain: reserved `mission_id`,
  `work_item_id`, `business_id`, business.project, binding.project,
  mission.project, assignee/org-agent scope.

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

## 8. R1 remediation — atomic rollback + origin proof

Independent audit `P14_FOUNDATION_V2_INDEPENDENT_AUDIT_BLOCKED — R1
REQUIRED`; closed as follows:

### §1 Atomic open rollback

`rollbackOpenIntentAtomic(workItemId, openId, toStatus, audit)` — used by
BOTH the direct open catch path and the mutation-gate/restart
reconciliation path — commits in **one** `store.immediate()`:

- work_item status restored + `pending_open_id`/`pending_open_at` cleared
  + claim fields cleared;
- binding `INTENT→ROLLED_BACK` + `rolled_back_at`;
- `WORK_ITEM_OPEN_ROLLED_BACK` audit event.

No crash boundary can leave a READY/no-pending item with a live INTENT
binding — a fault inside the txn aborts everything (recoverable pending
state), never a half-rollback. Idempotent: nothing to restore → no event.

### §2 Binding-driven `startBoundMission`

Signature is now `startBoundMission({ binding_open_id, ... })` — the seam
loads the `work_open_binding` itself and DERIVES the reserved mission_id
from it; it no longer accepts an arbitrary caller pin. Before mission
creation it validates via the canonical validator: binding exists +
state INTENT + work item resolves + business matches + business.project_id
== binding.project_id == requested project + org_agent resolves / same
business / ACTIVE / matches work-item assignee. Anything else →
`FAIL_CLOSED_BINDING_INVALID`.

### §3 Internal mission-origin proof

Missions created through the bound seam carry top-level
`bound_open_id = <binding open_id>` (set inside `createMission`, writable
only by that seam — public callers can never set it, and mission
metadata stays pure observability). "Mission belongs to binding X" is
derivable from canonical evidence, not from metadata fields.

### §4 Collision fails closed

If the reserved `mission_id` is already occupied by a mission WITHOUT
this binding's origin proof: `startBoundMission` throws
`FAIL_CLOSED_MISSION_ORIGIN_CONFLICT` and `reconcileOpenIntent`
quarantines the work item — never adopts, never flips BOUND. A true
crash-after-create retry adopts only when `bound_open_id === open_id`.

### §5-6 One canonical validator

`src/pair/work-open-binding.ts` exports `validateWorkOpenBinding` /
`validateWorkOpenBindingById` — used by `startBoundMission`,
`reconcileOpenIntent`, and `missionBoundToWorkItem` (hence sync, review,
block/cancel and every provenance check). Covers open_id, state,
mission_id, work_item, business, business.project, binding.project,
mission.project, org_agent/assignee scope, and the origin proof — no
weaker per-seam variants exist. Tampered business_id, drifted
project-pairs, wrong-agent and wrong-business bindings all fail closed.

### §7 R1 tests — `pair-p14-foundation.test.ts` (+10, now 20)

| Test | Verdict |
|---|---|
| FOUND-R1-ROLLBACK-ATOMIC | open failure → row restored + ROLLED_BACK + 1 audit atomically; forbidden READY+INTENT state never exists; retry emits no second rollback |
| FOUND-R1-ROLLBACK-ATOMIC (txn fault) | fault inside the rollback txn → nothing commits (recoverable pending+INTENT); clear fault → gate commits whole rollback once |
| FOUND-R1-SYNC-FAIL | pre-create bound-seam failure → original status, no pending, ROLLED_BACK, 0 missions, 1 audit |
| FOUND-R1-INTERNAL-COLLISION | foreign mission at reserved id w/o origin proof → never adopted, binding not BOUND, row quarantined |
| FOUND-R1-TRUE-CRASH-ADOPT | seam-created mission (origin proof) + forged same-open_id mission → restart adopts ONLY the proven one; BOUND once; no dup |
| FOUND-R1-CROSS-PROJECT-PAIR | binding+mission project drifted together → still fails (canonical Business anchors the project) |
| FOUND-R1-WRONG-AGENT | binding org_agent ≠ assignee → proof fails, quarantine |
| FOUND-R1-WRONG-AGENT-BUSINESS | binding agent in foreign business → fails |
| FOUND-R1-PUBLIC-STILL-BLOCKED | POST /api/missions + mission_id → 409 `FAIL_CLOSED_MISSION_ID_PUBLIC`, 0 rows |
| FOUND-R1-HAPPY | canonical open → BOUND + `bound_open_id` origin proof + governed pipeline intact |

## 9. R1 validation

| Surface | Result |
|---|---|
| Foundation V2 suite | **20/20** |
| P13 / P12 / P11 / P9 | 67/67 · 71/71 · 103/103 · 79/79 |
| Full suite — Node 22 | see CURRENT_STATE |
| Full suite — Node 20 | see CURRENT_STATE |
| Typecheck / build / audit | clean / PASS / 0 high |
| `verifyIntegrity()` | clean on every suite entry |
| Fresh-server E2E (PR #9 head) | verified — see PR comment |

## 10. Explicitly out of scope (foundation only)

No workforce layer: no work-graph decomposition, no agent delegation, no
heartbeat/autonomous claim loop, no inbox projection, no dependency
graph — those remain P14-workforce scope and are **not** implemented
here. `reviewWorkItem` is the minimal grounding seam required by §10,
not the full review/acceptance system.
