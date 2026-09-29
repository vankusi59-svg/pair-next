# PAIR OS NEXT — P14 AUTONOMOUS WORKFORCE + GOVERNED WORK GRAPH REPORT

**Branch:** `devin/1790682872-p14-autonomous-workforce`
**Base:** `main` @ `a38be24b8bb240570d0cce322766ece1bccceab9` (P13 official
closure — merged PR #7)
**Status:** `P14_IMPLEMENTED_PENDING_AUDIT`

P14 turns the P11–P13 governed work-item lifecycle into a **canonical
durable work graph** driven by an **autonomous workforce**: org_agents
claim and open eligible READY work on a deterministic heartbeat, delegate
and decompose under canonical rules, and close work through a governed
review — all over the existing single execution authority.

---

## 1. Architecture — one execution path, coordination layered on top

§0 honored. The audit found exactly one dispatch authority and P14 adds
none:

```
WorkforceService (coordination: inbox/graph/assign/delegate/decompose/heartbeat)
  → BusinessLayer.openWorkItem  (claim CAS + budget reserve + durable open intent)
    → MissionControl.startMission  (P12 contract pin + P13 canonical business_context)
      → Planner → MissionRouter → GovernedTaskGate → ExecutorAdapter
        → canonical evidence → verifyIntegrity
```

- `work_item` IS the graph node — no new node/edge tables, no parallel
  lifecycle, no alternate gate. Edges are columns on the canonical row:
  `parent_work_item_id`, `depends_on[]`, delegation provenance fields,
  `decomposition_id`, `required_capability`, `requires_review`,
  `reviewer_agent_id`, `blocked_code`.
- `WorkforceService` (`src/pair/workforce.ts`) is a coordination service
  over `BusinessLayer` — it never calls an executor, router, gate, or
  planner directly. The heartbeat's only executable act is
  `openWorkItem`, i.e. the same seam an operator uses.
- Read models (`workGraph`, `agentInbox`, `childrenOf`) are projections —
  they grant no authority and contain no secrets.

## 2. Work graph model (§2)

New canonical fields on `work_item`:

| field | purpose |
|---|---|
| `parent_work_item_id` | delegation/decomposition parent (same business) |
| `depends_on[]` | prerequisite work_item ids (same business) |
| `required_capability` | org_agent capability needed to be assigned/claimed |
| `requires_review` / `reviewer_agent_id` | governed review gate before DONE |
| `delegated_from_work_item_id` / `delegated_by_agent_id` / `delegation_reason` / `delegation_depth` / `delegation_key` | delegation provenance |
| `decomposition_id` | decomposition binding (idempotent materialization) |
| `blocked_code` | canonical blocked reason (`DEPENDENCY_FAILED`, `BLOCKED_CAPABILITY`) |

Enforcement in `BusinessLayer.createWorkItem` +
`updateWorkItemDeps` (the only dep-mutation path, CAS-gated):
- self-dependency → `FAIL_CLOSED_WORK_GRAPH_CYCLE`
- unknown dep → `FAIL_CLOSED_WORK_GRAPH_NODE`
- cross-business dep/parent → `FAIL_CLOSED_WORK_GRAPH_SCOPE`
- cycle via ancestor walk (depends_on + parent chain) → `FAIL_CLOSED_WORK_GRAPH_CYCLE`
- versionless/stale dep mutation → `FAIL_CLOSED_VERSION_CONFLICT`
- business graph > `PAIR_WORK_GRAPH_NODE_CAP` (64) → `FAIL_CLOSED_WORK_GRAPH_BOUND`

## 3. Lifecycle (§3)

`REVIEW_REQUIRED` added to the transition map:
`IN_PROGRESS → REVIEW_REQUIRED → DONE | READY | BLOCKED | CANCELLED`.

`openWorkItem` now gates on the dependency graph: any prerequisite not
DONE → `FAIL_CLOSED_WORK_ITEM_DEPENDENCY`. Executability therefore =
legal transition + deps DONE + assignee ACTIVE + capability +
claim/approval/budget/cost checks — all through the existing seam.

## 4. Inbox read model (§4)

`agentInbox(agent_id)` → `{ ready, in_progress, blocked,
waiting_dependency, review_required, recently_completed }`. `ready` is
recomputed against canonical dep state at read time; assigned work with
unsatisfied deps projects as `waiting_dependency`. Calling
`rebuildReadiness` first makes the projection restart-safe.

## 5. Heartbeat (§5)

`heartbeat(agent_id, actor)`:

1. resolve agent → must be ACTIVE (`FAIL_CLOSED_AGENT_INACTIVE`);
2. `rebuildReadiness` → canonical readiness (no process-memory queues);
3. per READY inbox item: `claimWorkItem` (claim CAS) then
   `openWorkItem` — the ONLY execution entry;
4. `syncWorkItem` sweep folds terminal mission state back;
5. every failure is recorded per-item (`skipped[].reason`), never
   blind-retried, never bypassed.

**Exactly-once under races:** claim + open are CAS writes; deterministic
delegation/decomposition ids serialize materialization at the version-0
INSERT; mission creation is deduped by the durable `pending_open_id`
open intent. Two heartbeats racing one item → one owner, one mission —
proven by a real `worker_threads` race test.

## 6. Delegation (§6)

`delegateWorkItem({work_item_id, delegated_by_agent_id,
delegated_to_agent_id, reason?, delegation_key?}, actor)`:
- delegator + target must be ACTIVE agents of the item's business;
- target must satisfy the parent's `required_capability` (delegation
  narrows, never expands);
- depth bounded by `delegation_depth ≤ PAIR_WORK_DELEGATION_DEPTH_CAP`
  (5); business graph bounded by the node cap;
- child id is `WI_DL_<sha256(parent|key)[:20]>` — deterministic: a repeat
  or racing call returns the existing child (no double delegation);
- `WORK_DELEGATED` event (metadata only) + provenance columns.

## 7. Decomposition (§7)

`decomposeWorkItem(workItemId, {decomposition_id, children[]}, actor)`:
proposal-only input is validated and materialized deterministically —
children per call ≤ `PAIR_WORK_DECOMPOSE_CHILD_CAP` (16), sibling dep
indices in range and pointing at earlier siblings (acyclic by
construction), assignees ACTIVE same-business agents, children inherit
the parent's canonical `business_id` (caller business identity never
trusted), required capability inherited. Child ids are
`WI_DC_<sha256(parent|decomp|i)[:20]>` — retried or raced materialization
returns the same nodes; `WORK_DECOMPOSED` event once.

## 8. Assignment (§8)

`assignWork` / `autoAssign` operate on canonical facts only: agent
ACTIVE, same business, `required_capability` declared. No eligible agent
→ `BLOCKED` + `blocked_code=BLOCKED_CAPABILITY` (explicit, never
pretended executable). `autoAssign` picks the least-loaded eligible
agent by live non-terminal claim count. No CEO reasoning — that is P15.

## 9. Review (§9)

`reviewWorkItem(workItemId, {reviewer_agent_id, decision, note}, actor)`:
- node must be in `REVIEW_REQUIRED` (set by `syncWorkItem` when a
  `requires_review` mission completes — DONE is never auto-granted);
- reviewer must be an ACTIVE agent of the same business, and never the
  producing assignee (`FAIL_CLOSED_WORK_REVIEW_SELF`);
- `ACCEPT` → DONE (propagates readiness) + `WORK_REVIEW_ACCEPTED`;
- `REWORK` → READY + `WORK_REWORK_REQUESTED` + blocker note;
- reviewer gains no execution authority — the write is a status gate only.

## 10. Dependency propagation (§10)

`propagateDependents` fires on every terminal transition (sync, cancel,
review accept): prereq DONE → dependents with all deps satisfied +
assignee promote BACKLOG→READY (`WORK_READY`); prereq failed/cancelled →
dependents BLOCKED `DEPENDENCY_FAILED` (`WORK_BLOCKED`), recursively.
`rebuildReadiness(businessId)` reconstructs the same state on every
`board()`/`agentInbox`/heartbeat sweep — restart never trusts memory.

## 11. Crash/restart/idempotency (§11)

Everything canonical: graph edges, claims, pending open intents, mission
bindings all live in `work_item` rows under version CAS. Replayed
heartbeat re-derives inbox from rows; stale `pending_open_id` beyond the
grace window is reconciled by the existing `reconcileOpenIntents` sweep
(no mission → item returns to READY; mission exists → linked, never
duplicated). Deterministic `WI_DL_*`/`WI_DC_*` ids make delegation and
decomposition exactly-once across processes. `verifyIntegrity` clean in
all race/restart tests.

## 12. P12/P13 inheritance (§12/§13)

Unchanged: contract pin at `startMission`, effective = pinned ∩ current ∩
PAIR at dispatch; canonical `business_context` pin consumed by
CostService; capability-gated `bcap1` broker fetch; sanitizer boundary on
untrusted remote output. Heartbeat open runs the entire chain — a work
item's autonomy is bound by exactly the authority its assignee already
had. Delegation/decomposition create plain nodes; they never touch
permissions, approvals, budgets, or secrets.

## 13. API surface (§14)

Operator-authenticated (existing `x-operator-id` POST gate):

| method | endpoint |
|---|---|
| GET | `/api/workforce/graph?business_id=` |
| GET | `/api/workforce/inbox?agent_id=` |
| GET | `/api/work-items/:id/children` |
| POST | `/api/workforce/heartbeat` `{agent_id}` |
| POST | `/api/work-items/:id/delegate` `{delegated_by_agent_id, delegated_to_agent_id, reason?, delegation_key?}` |
| POST | `/api/work-items/:id/decompose` `{decomposition_id, children[]}` |
| POST | `/api/work-items/:id/review` `{reviewer_agent_id, decision: ACCEPT\|REWORK, note?}` |
| POST | `/api/work-items/:id/auto-assign` |
| POST | `/api/work-items` — extended: `depends_on`, `parent_work_item_id`, `required_capability`, `requires_review`, `reviewer_agent_id` |
| POST | `/api/org-agents` — extended: `capabilities[]` |

No unauthenticated mutation surface; projections carry ids + metadata
only, never secret material (vault values are never placed on work rows).

## 14. Evidence events (§15)

`WORK_DELEGATED`, `WORK_DECOMPOSED`, `WORK_READY`, `WORK_BLOCKED`,
`WORK_REVIEW_ACCEPTED`, `WORK_REWORK_REQUESTED`, `WORK_DEPS_UPDATED` —
all metadata-only, written through the same `store.event` audit channel
(`verifyIntegrity`-compatible). Existing `WORK_ITEM_*` events kept.

## 15. Test matrix (§17) — 31 tests, all passing

| area | tests |
|---|---|
| graph | GRAPH-A edges/projection · B self-dep · C cycle · D cross-biz+unknown · E versionless CAS · F propagation + failed prereq |
| assignment | A valid+capability · B inactive/foreign · C BLOCKED_CAPABILITY · D least-loaded pick |
| delegation | A provenance+event · B idempotent retry · C scope/inactive/self · D depth cap · E capability narrowing |
| decomposition | A deterministic materialization · B idempotent retry + change rejected · C cyclic/OOR/foreign assignee |
| inbox | A five-bucket projection, read is side-effect free |
| review | A REVIEW_REQUIRED→accept→propagate · B rework→READY · C self/foreign/wrong-state rejected |
| heartbeat | A claim+open via canonical seam · B ignores blocked/waiting · C inactive agent · HB-RACE two workers → one owner+one mission · HB-RESTART fresh ctx → no duplicate |
| recovery | REC-A stale pending intent reconciled once · REC-B readiness rebuilt on restart |
| races | D-RACE same delegation key → one child · C-RACE two claimers → one owner |

New error codes: `FAIL_CLOSED_WORK_GRAPH_CYCLE`,
`FAIL_CLOSED_WORK_GRAPH_NODE`, `FAIL_CLOSED_WORK_GRAPH_SCOPE`,
`FAIL_CLOSED_WORK_GRAPH_BOUND`, `FAIL_CLOSED_WORK_ITEM_DEPENDENCY`,
`FAIL_CLOSED_WORK_DELEGATE_SCOPE`, `FAIL_CLOSED_WORK_DELEGATE_SELF`,
`FAIL_CLOSED_WORK_DELEGATION_BOUND`, `FAIL_CLOSED_WORK_CAPABILITY`,
`FAIL_CLOSED_WORK_REVIEW_STATE`, `FAIL_CLOSED_WORK_REVIEW_SCOPE`,
`FAIL_CLOSED_WORK_REVIEW_SELF`, `FAIL_CLOSED_WORK_DECOMPOSE`.

## 16. Validation evidence

| gate | result |
|---|---|
| P14 focused suite | **31/31 PASS** (includes 3 real worker_threads races) |
| P13 suite | 67/67 |
| P12 suite | 71/71 |
| P11 suite | 103/103 |
| P9 suite | 79/79 |
| typecheck (`tsc --noEmit`) | clean |
| build (`pnpm build`) | PASS |
| `pnpm audit --audit-level=high` | 0 high / 0 critical (9 moderate/low, pre-existing) |
| Node 22 full | — (recorded below) |
| Node 20 full | — (recorded below) |
| verifyIntegrity | clean in every race/restart test |

## 17. Limitations / not yet

- Heartbeat is invoked per-agent (API op) — the always-on tick loop +
  CEO-level gap analysis remain P15.
- `blocked_code` values are canonical constants but not an enum table.
- Inbox `recently_completed` returns last 10 terminal nodes — no time
  window filter.
- UI modernization intentionally out of scope.

Classification: **`P14_IMPLEMENTED_PENDING_AUDIT`** — DO NOT MERGE.

---

# REMEDIATION R1 — audit-block closure

Audited head: `59a2e572f50f148c195df998f77d26eea3eee634`
Result: `P14_INITIAL_INDEPENDENT_AUDIT_BLOCKED — R1 REQUIRED`

## R1.1 Graph acyclicity is concurrency-safe

`updateWorkItemDeps()` now runs validation + CAS write + event +
propagation inside **one `store.immediate()` transaction** (BEGIN
IMMEDIATE — single-writer serialization on the existing
PairEvidenceStore; no second store or lock service). `createWorkItem()`
similarly runs edge validation + node-cap check + version-0 INSERT inside
`store.immediate()`, so the graph node cap cannot be outraced.

GRAPH-R1-RACE (real `worker_threads`, two DB connections): worker1 sets
`A.depends_on=[B]` while worker2 sets `B.depends_on=[A]` — serialized
writers mean the second transaction validates against the first's
committed edge, detects the cycle, and fails closed (`FAIL_CLOSED_*`).
Exactly one legal mutation succeeded; the final graph is acyclic;
`verifyIntegrity()` clean.

## R1.2 Decomposition is atomic and single-authority

`decomposeWorkItem()` now performs parent-decomposition binding + proposal
validation + child materialization + parent state + `WORK_DECOMPOSED`
evidence inside **one `store.immediate()` transaction**:

- same `decomposition_id` raced → both callers converge to the canonical
  child set, one event (DECOMP-R1-SAME-RACE);
- two different `decomposition_id`s raced → exactly one winner; the loser
  fails closed `FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT` and materializes zero
  children (DECOMP-R1-CONFLICT-RACE);
- crash/fault mid-materialization → transaction rollback: no orphan
  children, no parent binding; a retry materializes cleanly
  (DECOMP-R1-CRASH, injected fault at child #2 write);
- sequential different-id decomposition → `FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT`.

## R1.3 Named reviewer authority

`reviewWorkItem()`: when `work_item.reviewer_agent_id` is configured, only
that exact canonical agent may decide — any other reviewer fails
`FAIL_CLOSED_WORK_REVIEWER_MISMATCH` (checked before scope checks).
The configured reviewer must still be same-business, ACTIVE, and not the
producing assignee. With no configured reviewer the documented fallback
remains: any ACTIVE same-business non-assignee agent (REVIEW-R1-NAMED
covers exact/other/foreign/inactive/self cases).

## R1.4 Strict review decision

The decision enum is enforced inside the service: anything other than the
exact strings `ACCEPT` or `REWORK` fails `FAIL_CLOSED_WORK_REVIEW_DECISION`.
The API now passes the raw `decision` through instead of mapping
"not REWORK → ACCEPT". REVIEW-R1-API: `accept`, ``, `MAYBE`, `DONE`,
`REWORKED`, `ACCEPT ` all fail closed; the item stays `REVIEW_REQUIRED`.

## R1.5 Parent completion respects the child graph

All materialized children (delegated/decomposed) are mandatory: a parent
can reach `DONE`/`REVIEW_REQUIRED` only when every child is `DONE`.

- `syncWorkItem`: mission completed while children are incomplete →
  parent parks `IN_PROGRESS` with `blocked_code=CHILD_INCOMPLETE`
  (idempotent, no version churn).
- `evaluateParentCompletion`: when the last child reaches DONE, the
  parked parent resumes to `DONE` (or `REVIEW_REQUIRED` when
  `requires_review`) and propagates downstream.
- `reviewWorkItem` ACCEPT with incomplete children →
  `FAIL_CLOSED_PARENT_INCOMPLETE`.
- CANCELLED children do **not** count as complete — documented
  fail-closed policy: the parent must be cancelled explicitly or the
  cancelled child reworked/replaced.

PARENT-R1: parent mission completes while child open → parent stays
`IN_PROGRESS`/`CHILD_INCOMPLETE`; review ACCEPT on a parent with an open
child fails closed; child DONE → parent `DONE`. PARENT-R1-RESTART: a
reopened context enforces the same gate.

## R1.6 Inbox is a true read-only projection

`agentInbox()` no longer calls `rebuildReadiness` — it computes bucket
membership against canonical state without writing. Reconciliation moved
to the mutation seam: `heartbeat()` calls `rebuildReadiness` before
reading its inbox; `board()` already reconciles. INBOX-R1: three
consecutive inbox reads leave entities, versions, statuses, and the event
count byte-identical.

## R1.7 Capability admission is consistent

`createWorkItem` fails `FAIL_CLOSED_WORK_CAPABILITY` when the assignee
cannot declare `required_capability`; `decomposeWorkItem` fails the same
way for any incapable child assignee before any child materializes;
`rebuildReadiness` demotes incapable BACKLOG/READY assignments to
`BLOCKED`/`BLOCKED_CAPABILITY` (never promotes them). CAP-R1 covers
direct create, decomposition, and injected legacy rows.

## R1 validation

| gate | result |
|---|---|
| P14 suite | **41/41 PASS** (10 new R1 tests incl. 3 worker races) |
| P13 | 67/67 · P12 71/71 · P11 103/103 · P9 79/79 |
| typecheck | clean · build PASS |
| audit | 0 high / 0 critical |
| Node 22 full | 1964 pass / 2 env P5 probe (CodexCli executable absent — same documented env gap) |
| Node 20 full | **1966/0** |
| verifyIntegrity | clean in every race/restart test |

Classification: **`P14_REMEDIATED_R1_PENDING_AUDIT`** — DO NOT MERGE.

---

# REMEDIATION R2 — delegation crash atomicity + recursive parent completion

Audited head `fe27321e`, base `a38be24`. Eight requirements, all closed on
the same PR #8. DO NOT MERGE — audit pending.

## R2.1 — Delegation is crash-atomic (§1)

`WorkforceService.delegateWorkItem` now performs the ENTIRE delegation
inside one `PairEvidenceStore.immediate()` transaction: bounds/scope checks,
deterministic child creation (`WI_DL_<sha256(parent|key)>`), and the
canonical `WORK_DELEGATED` event. `delegation_key` is written at the
child's initial canonical creation (`createWorkItem` accepts it — no
follow-up patch write). A fault anywhere rolls back the child's
WORK_ITEM_CREATED event, the child row, all provenance and the
WORK_DELEGATED event together.

**Evidence — DELEG-R2-CRASH**: `store.event` patched to throw
`FAIL_CLOSED_TEST_INJECTED` on `WORK_DELEGATED` (fault lands AFTER child
materialization, before commit) → the delegation throws, the store contains
**zero** children of the parent and **zero** WORK_DELEGATED events; the
same-key retry then succeeds with full provenance (`delegation_key`,
`delegated_from_work_item_id`, `delegated_by_agent_id`, `assignee`,
`delegation_depth=1`) and exactly one event.

## R2.2 — Replay validates provenance; repairs or fails closed (§2)

A deterministic child already present is accepted as a successful replay
ONLY when business, parent, `delegated_from_work_item_id`,
`delegated_by_agent_id`, `assignee` (delegated_to), `delegation_depth` and
`required_capability` all match the call — otherwise
`FAIL_CLOSED_WORK_DELEGATE_CONFLICT`. A legacy/partial child whose only gap
is a missing `delegation_key` is repaired deterministically inside the same
transaction (provably safe: every other provenance field verified first);
a `delegation_key` mismatch fails closed.

**Evidence — DELEG-R2-PROVENANCE+REPLAY**: all provenance asserted on the
created child; three same-key replays return the same row with
`delegation_key` intact and `WORK_DELEGATED` count stays 1; a replay with
a different delegatee under the same key →
`FAIL_CLOSED_WORK_DELEGATE_CONFLICT`; a seeded legacy row (full provenance,
`delegation_key=null`) is repaired to `delegation_key=K-LEGACY`.

## R2.3 — Every DONE transition re-evaluates the parent (§3)

`propagateDependents()` — the single seam every canonical terminal
transition already funnels through (syncWorkItem fold, reviewWorkItem
ACCEPT, cancellation, dep mutation) — now ends with: node DONE ∧ parent
exists → `evaluateParentCompletion(parent)`. A `REVIEW_REQUIRED` child
accepted to DONE therefore releases a parked parent **in the same call** —
no heartbeat/board sweep needed.

**Evidence — PARENT-R2-REVIEWED-CHILD**: parent parked
`IN_PROGRESS+CHILD_INCOMPLETE`, child → `REVIEW_REQUIRED`, reviewer ACCEPT
→ child DONE → parent immediately `REVIEW_REQUIRED` (it is itself
`requires_review`) in the same synchronous call.

## R2.4 — Multi-level cascade (§4)

The §3 seam is recursive: when the parent itself finalizes to DONE, its
own `propagateDependents` call re-evaluates the grandparent — chains
converge naturally from the DONE transition.

**Evidence — PARENT-R2-CASCADE**: gp → delegated mid → delegated leaf;
gp and mid complete their missions and both park `CHILD_INCOMPLETE`;
leaf completes → leaf DONE → mid DONE → gp DONE in one sweep.

## R2.5 — One canonical finalization path (§5)

The syncWorkItem terminal fold was extracted into
`finalizeWorkItem(row, from, next, mission, meta)` — the ONLY completion
implementation: `assertWorkItemTransition`, status write,
`blocked_code` cleared, claim/token/expiry released, result_summary
grounded in the completed mission, CAS write, dependent propagation,
assignee context note, `WORK_ITEM_SYNCED` event. `evaluateParentCompletion`
now calls it — a parked parent's auto-completion is byte-for-byte the same
finalization as a directly-synced item (requires_review → REVIEW_REQUIRED).
If the parent's completed mission row is absent (corrupt state) it stays
parked — completion is never fabricated.

**Evidence — PARENT-R2-CANONICAL-FINALIZE**: released parent has
`claimed_by/claim_token/claim_expires_at = null`, `result_summary` equal
to the mission result, exactly one `WORK_ITEM_SYNCED(cause=
children_complete)` event; repeated `syncWorkItem` + `rebuildReadiness` +
`heartbeat` afterwards → version unchanged, still one event.

## R2.6 — Concurrency / idempotency (§6)

`finalizeWorkItem` treats `FAIL_CLOSED_VERSION_CONFLICT` as convergence:
the CAS loser re-reads the row and returns the winner's identical terminal
state — no duplicate transition, no duplicate event, no stale claim.

**Evidence — PARENT-R2-RACE ×2** (real worker_threads): (a) two workers
fold the two final children concurrently → parent DONE once, one
completion event, claim fields null, verifyIntegrity clean; (b) two
workers `syncWorkItem` the same parked parent → one canonical transition,
one event, verifyIntegrity clean.

## R2 validation

| gate | result |
|---|---|
| P14 suite | **48/48 PASS** (7 new R2 tests incl. 2 worker races) |
| P13 | 67/67 · P12 71/71 · P11 103/103 · P9 79/79 |
| typecheck | clean · build PASS |
| audit | 0 high / 0 critical |
| Node 22 full | 1971 pass / 2 env P5 probe (CodexCli executable absent — same documented env gap) |
| Node 20 full | **1973/0** |
| verifyIntegrity | clean in every race/restart/crash test |

All R1 closures unchanged (atomic graph mutation, atomic decomposition,
named reviewer, strict decisions, parent gate, read-only inbox, capability
admission). No second store, router, dispatcher or execution engine.

Classification: **`P14_REMEDIATED_R2_PENDING_AUDIT`** — DO NOT MERGE.

---

# REMEDIATION R3 — audit-provenance replay + crash-atomic terminal transitions

Audited head `9c022a3e`, base `a38be24`. Five requirement groups, all closed
on the same PR #8. DO NOT MERGE — audit pending.

## R3.1 — Delegation completeness = row ∧ event (§1)

`ensureDelegationEvent(parent, childId, key, by, to)` now runs inside the
delegation transaction on BOTH the replay-repair and the fresh-create
paths. It admits exactly-one matching `WORK_DELEGATED` for the child:
zero events → the audit is emitted (repair); one event whose metadata
(`delegation_key`, `delegated_from`, `delegated_to`) matches → accepted;
a metadata conflict or a duplicate audit →
`FAIL_CLOSED_WORK_DELEGATE_CONFLICT`. Replay therefore validates row
provenance AND audit provenance, restoring a missing event atomically in
the same transaction that repairs a missing `delegation_key`.

**Evidence — DELEG-R3-MISSING-EVENT**: seeded child, key present, no event
→ replay returns the child and restores exactly one correct event.
**DELEG-R3-MISSING-KEY-EVENT**: keyless legacy child, no event → replay
repairs `delegation_key` AND emits the event in one transaction.
**DELEG-R3-CONFLICT-EVENT**: a pre-existing `WORK_DELEGATED` carrying a
different key → `FAIL_CLOSED_WORK_DELEGATE_CONFLICT`, no new event.

## R3.2 — Finalization is one atomic transaction (§2, option A)

`finalizeWorkItem` now wraps the ENTIRE authoritative fold in
`store.immediate()`: transition assert, status/`blocked_code`/claim write,
CAS put, `propagateDependents` (which itself carries the parent-eval hook
and the cascade), agent outcome note, `WORK_ITEM_SYNCED`. A fault anywhere
rolls back the whole fold — no canonical terminal state without
provenance can exist post-R3. Concurrent finishers still converge through
the CAS-conflict re-read outside the transaction.

**Evidence — FINALIZE-R3-CRASH**: `store.event` patched to throw on
`WORK_ITEM_SYNCED` after the row write → `syncWorkItem` fails, row stays
`IN_PROGRESS` with its claim intact, zero sync events; retry completes
(DONE, claim cleared, exactly one event).

## R3.3 — Review decision is crash-atomic (§3)

`reviewWorkItem`'s mutation + `WORK_REVIEW_ACCEPTED`/`WORK_REWORK_REQUESTED`
event + `propagateDependents` (incl. the parent-eval cascade) now commit in
one `store.immediate()`. A fault between the state write and the event
leaves the child `REVIEW_REQUIRED` — a retry converges.

**Evidence — REVIEW-R3-CRASH**: injected fault on `WORK_REVIEW_ACCEPTED`
→ throw, child stays `REVIEW_REQUIRED`, parent stays `CHILD_INCOMPLETE`;
unpatched retry → child DONE, one review event, parent released to
`REVIEW_REQUIRED` in the same call.

## R3.4 — Restart reconciliation closes partial states (§4)

New `reconcileTerminalConsistency(businessId)` runs at the head of
`rebuildReadiness` (the existing heartbeat/board mutation seam), inside one
transaction, and is idempotent:
- terminal/REVIEW_REQUIRED row missing `WORK_ITEM_SYNCED` → re-runs
  propagation (state-gated → no dup) + dedup-checked context note + emits
  `WORK_ITEM_SYNCED{cause:"restart_reconcile"}`;
- terminal row holding claim/token/expiry → cleared;
- DONE `requires_review` row missing `WORK_REVIEW_ACCEPTED` → reconcile
  audit marker emitted;
- delegated child carrying `delegation_key` but no `WORK_DELEGATED` →
  event repaired (keyless rows are left for the replay path, which repairs
  key+event atomically — a keyless repair event would conflict-block it);
- DONE child under a `CHILD_INCOMPLETE` parent → the propagation hook
  releases the parent.

**Evidence — PARENT-R3-RESTART**: child `DONE` + parked parent persisted,
fresh `PairEvidenceStore`/business layer over the same DB →
`rebuildReadiness` releases the parent (`DONE`), emits the child's missing
sync event and the parent's `children_complete` event; verifyIntegrity
clean. **FINALIZE-R3-IDEMPOTENT**: three rebuildReadiness sweeps over a
DONE row with stale claim + no sync event → claim cleared once, exactly
one `WORK_ITEM_SYNCED`, exactly one context note.

## R3.5 — Concurrency preserved (§5)

`finalizeWorkItem`'s CAS loser re-reads and converges; `reviewWorkItem`'s
txn serializes competing decisions (loser fails `VERSION_CONFLICT` or
`WORK_REVIEW_STATE`); `ensureDelegationEvent` only runs inside the
serialized delegation transaction — a racing replay sees committed state.

**Evidence — RACE-R3** (real worker_threads): two workers `ACCEPT` the
same `REVIEW_REQUIRED` child while a third syncs the parked parent → child
DONE once, one `WORK_REVIEW_ACCEPTED`, parent `REVIEW_REQUIRED` once, one
`children_complete` sync event, verifyIntegrity clean.

## R3 validation

| gate | result |
|---|---|
| P14 suite | **56/56 PASS** (8 new R3 tests incl. 1 three-way worker race) |
| P13 | 67/67 · P12 71/71 · P11 103/103 · P9 79/79 |
| typecheck | clean · build PASS |
| audit | 0 high / 0 critical |
| Node 22 full | 1979 pass / 2 env P5 probe (CodexCli executable absent — documented env gap) |
| Node 20 full | **1981/0** |
| verifyIntegrity | clean in every race/crash/restart test |

All R1 + R2 closures unchanged. No second store, router, dispatcher or
execution engine; no new locking — `PairEvidenceStore.immediate()` is the
single transaction authority.

Classification: **`P14_REMEDIATED_R3_PENDING_AUDIT`** — DO NOT MERGE.

---

# P14 REMEDIATION R4 — GROUNDED TERMINAL RECOVERY + AUDIT PROVENANCE

Mandate: recovery must never infer a transition from terminal status alone —
canonical evidence proves the transition, ungrounded terminal state fails
closed, review acceptance is never fabricated, and the `WORK_DELEGATED`
audit check is global-by-child.

## R4.1 — Grounded-proof recovery (§1–§2, §5)

`reconcileTerminalConsistency` now classifies every terminal-ish row by a
canonical proof, never by status:

| row state | canonical proof required |
|---|---|
| `DONE` (no review) | linked mission exists, belongs to the item, is `COMPLETED` |
| `REVIEW_REQUIRED` | `requires_review` + linked mission `COMPLETED` |
| `DONE` + `requires_review` | an actual stored `WORK_REVIEW_ACCEPTED` for this item — reviewer identity is never inferred from `reviewer_agent_id` |
| `CANCELLED` | a real `WORK_ITEM_CANCELLED` event (explicit cancel) or a `CANCELLED` linked mission (mission-cancelled fold) — the two causes stay distinguishable |
| `BLOCKED` | `DEPENDENCY_FAILED` / `BLOCKED_CAPABILITY` code or a terminal (FAILED/PAUSED/CANCELLED) linked mission |

When the proof exists but recorded effects are missing, recovery emits a
clearly-named `WORK_TERMINAL_REPAIRED` marker (actor `PAIR_RECONCILE`,
metadata carries `proven_transition` + `mission_id`) and restores only the
proven effects — dependency propagation, parent completion evaluation, a
dedup'd agent context outcome. It does **not** require every terminal row
to carry `WORK_ITEM_SYNCED`, creates no DONE→DONE / CANCELLED→CANCELLED
markers, and never impersonates the original transition event.

## R4.2 — Ungrounded terminal fails closed (§3, §6, §7)

A terminal row with no canonical proof is quarantined, never normalized:
`blocked_code = "TERMINAL_PROVENANCE_CORRUPT"` plus exactly one
`WORK_PROVENANCE_INCONSISTENT` audit event (idempotent — dedup'd by event
presence). A corrupt row: promotes no dependent (`depsSatisfied` excludes
it), releases no parked parent (`mandatoryChildrenComplete` excludes it),
gets no propagation/context/bookkeeping, and stays inspectable for the
operator.

## R4.3 — No fabricated review acceptance (§4)

The R3 rule that emitted `WORK_REVIEW_ACCEPTED` for `DONE` +
`requires_review` rows is removed. `proof = reviewed.has(id)` — only a
real stored acceptance counts; an approval with `reviewer: null` can never
be created. A `DONE` review item whose mission completed but whose
acceptance never happened is quarantined as ungrounded.

## R4.4 — Global `WORK_DELEGATED` uniqueness (§8–§9)

`ensureDelegationEvent` and the restart sweep both index every
`WORK_DELEGATED` by `metadata.child_work_item_id` regardless of
`entity_id`:

- **0 events** → emit one canonical event, but only when the child row's
  provenance is complete (key + delegated_from/by + assignee); a keyless
  legacy row is left for the replay path which repairs key + event
  atomically — restart never guesses a key.
- **1 event** → validate `entity_id === delegated_from_work_item_id` AND
  metadata key/from/to — any mismatch fails closed.
- **>1 event** → duplicate audit fails closed.

Conflicts quarantine the child (`TERMINAL_PROVENANCE_CORRUPT` +
`WORK_PROVENANCE_INCONSISTENT`) and replay throws
`FAIL_CLOSED_WORK_DELEGATE_CONFLICT`; no repair is attempted against
conflicting evidence.

## R4 evidence — 10 new tests (P14: 66/66)

- **GROUND-R4-UNGROUNDED-DONE**: forced `DONE`, no mission → corrupt
  marker + one inconsistency event, zero `WORK_ITEM_SYNCED`, zero context
  notes, idempotent on repeat sweeps.
- **GROUND-R4-DEPENDENT**: dependent of a corrupt `DONE` stays `BACKLOG`.
- **GROUND-R4-PARENT**: parked `CHILD_INCOMPLETE` parent is NOT released
  by an ungrounded `DONE` child.
- **GROUND-R4-LEGACY-SYNC**: real completed mission + forced `DONE` →
  one `WORK_TERMINAL_REPAIRED`, dependent promoted `READY`, one context
  note.
- **REVIEW-R4-NO-FABRICATION**: `requires_review` `DONE` with completed
  mission but no ACCEPT → corrupt; zero `WORK_REVIEW_ACCEPTED`.
- **REVIEW-R4-VALID**: a real ACCEPT survives repeated recovery — still
  one event, clean row.
- **CANCEL-R4-SEMANTICS**: explicit cancel keeps its
  `WORK_ITEM_CANCELLED`, no synthetic sync on repeated sweeps.
- **DELEG-R4-WRONG-PARENT-EVENT**: audit stored under another entity_id →
  replay `FAIL_CLOSED_WORK_DELEGATE_CONFLICT`, no new event, no child.
- **DELEG-R4-DUP-EVENT**: second injected audit → replay fails closed;
  restart sweep adds nothing and quarantines the child.
- **DELEG-R4-RECONCILE-CONFLICT**: row vs audit disagreement at restart →
  child corrupt + inconsistency event, no repair.

Pre-R4 fixtures that seeded `DONE` without a mission (REC-B,
PARENT-R3-RESTART, FINALIZE-R3-IDEMPOTENT) were updated to ground the
terminal state through a real completed mission — the scenarios they
prove are unchanged, but recovery now repairs only canonical proof.

## R4 validation

| gate | result |
|---|---|
| P14 suite | **66/66 PASS** (10 new R4 tests) |
| P13 | 67/67 · P12 71/71 · P11 103/103 · P9 79/79 |
| typecheck | clean · build PASS |
| audit | 0 high / 0 critical |
| Node 22 full | 1989 pass / 2 env P5 probe (CodexCli executable absent — documented env gap) |
| Node 20 full | **1991/0** |
| verifyIntegrity | clean in every crash/restart/race/quarantine test |

All R1/R2/R3 closures unchanged; `PairEvidenceStore.immediate()` remains
the single transaction authority; no second store/router/dispatcher.

Classification: **`P14_REMEDIATED_R4_PENDING_AUDIT`** — DO NOT MERGE.

---

# P14 REMEDIATION R5 — HARD QUARANTINE + STRONGLY-BOUND TERMINAL PROOF

Mandate: `TERMINAL_PROVENANCE_CORRUPT` must be a hard quarantine (not just
a marker), recovery proof must be strongly bound to the work item, and a
reviewed DONE requires BOTH execution proof and a validated ACCEPT event —
while a legacy valid ACCEPT still repairs its derived effects.

## R5.1 — Hard quarantine (§1–§2, §7)

One centralized guard: `assertWorkItemNotQuarantined(row, op)` →
`FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`. Wired into every authority-bearing
path:

| path | enforcement |
|---|---|
| `openWorkItem` | guard after resolve — corrupt never opens |
| `claimWorkItem` | guard — corrupt never claimable |
| `assignWorkItem` / `autoAssign` | guard — reassignment cannot launder quarantine back to READY |
| `reviewWorkItem` ACCEPT + REWORK | guard before state check — neither escapes |
| `updateWorkItemDeps` | guard — no dependency mutation on corrupt rows |
| `syncWorkItem` | corrupt row is a no-op fold (sweep-safe) |
| `propagateDependents` | corrupt node propagates nothing |
| `delegateWorkItem` / `decomposeWorkItem` | quarantined parent cannot mint fresh authority |
| `agentInbox` | corrupt rows surface in `blocked`, never `ready` |
| `rebuildReadiness` | corrupt rows are skipped — never re-promoted |
| `heartbeat` | inherits claim/open guards + inbox exclusion → zero claim, zero mission, zero dispatch |

## R5.2 — Strongly-bound mission proof (§3)

`missionBound(w, m)` requires ALL of: `m.metadata.work_item_id ===
w.work_item_id`, `m.metadata.business_id === w.business_id`,
`m.metadata.source === "business_layer"`, and a non-empty
`work_item_open_id` (the canonical open seam always stamps one). A foreign
`COMPLETED` mission id planted in `mission_ids` grounds nothing — the row
quarantines and propagates no success.

## R5.3 — Review proof = execution ∧ validated ACCEPT (§4–§6)

For `requires_review` DONE: proof requires BOTH a bound `COMPLETED`
mission AND `acceptProof(w) === "valid"` — exactly one
`WORK_REVIEW_ACCEPTED` with `old_state=REVIEW_REQUIRED`,
`new_state=DONE`, a present `reviewer_agent_id` whose canonical agent
belongs to the same business, is not the assignee, and matches a named
`reviewer_agent_id` when configured. Zero events → ungrounded; >1 events
or any field mismatch → quarantine. No ACCEPT is ever synthesized.

A valid ACCEPT repairs missing derived effects — propagation, parked
parent evaluation, assignee outcome note — under one `WORK_TERMINAL_REPAIRED`
marker; `derivedEffectsMissing` detects the gap canonically (no note /
parent still `CHILD_INCOMPLETE` / promotable dependent still `BACKLOG`)
so a healthy post-R3 ACCEPT is a no-op and repeats add nothing.

## R5 evidence — 9 new tests (P14: 75/75)

- **QUAR-R5-READY**: READY delegated child + injected conflicting
  `WORK_DELEGATED` → rebuild quarantines → heartbeat opens/claims/dispatches
  nothing; inbox shows blocked, not ready.
- **QUAR-R5-OPEN / QUAR-R5-CLAIM** (one test): open, claim, and assign on
  a quarantined row all throw `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`.
- **QUAR-R5-REVIEW**: quarantined `REVIEW_REQUIRED` — ACCEPT and REWORK
  both fail closed; zero review events added.
- **MISSION-R5-WRONG-WORK**: A's real `COMPLETED` mission id planted in B
  → B quarantined; dependent never promoted.
- **MISSION-R5-WRONG-BUSINESS**: cross-business mission id planted →
  quarantined.
- **REVIEW-R5-PROOF**: self-reviewer ACCEPT event (also violating the
  named-reviewer binding) → quarantined, no synthesized replacement.
- **REVIEW-R5-DUP**: real ACCEPT + injected second ACCEPT → conflicting
  audit → quarantined.
- **REVIEW-R5-LEGACY-PROPAGATION**: bound mission + valid seeded ACCEPT +
  `DONE` child + parked parent → fresh-process rebuild releases parent
  exactly once, one marker, still one ACCEPT.
- **REVIEW-R5-IDEMPOTENT**: normal ACCEPT → 3 sweeps → one ACCEPT, one
  READY event on the dependent, clean row.

## R5 validation

| gate | result |
|---|---|
| P14 suite | **75/75 PASS** (9 new R5 tests) |
| P13 | 67/67 · P12 71/71 · P11 103/103 · P9 79/79 |
| typecheck | clean · build PASS |
| audit | 0 high / 0 critical |
| Node 22 full | 1998 pass / 2 env P5 probe (CodexCli executable absent — documented env gap) |
| Node 20 full | **2000/0** |
| verifyIntegrity | clean in every quarantine/crash/restart/race test |

All R1–R4 closures unchanged; `PairEvidenceStore.immediate()` remains the
single transaction authority; no second store/router/dispatcher.

Classification: **`P14_REMEDIATED_R5_PENDING_AUDIT`** — DO NOT MERGE.

---

# §R6 — CANONICAL PROOF AT AUTHORITY SEAMS + QUARANTINE CLOSURE

Audit verdict on `ab0a2fe`: R1–R5 closed; P14 BLOCKED on the recovery
proof living only inside `reconcileTerminalConsistency` — live authority
paths still trusted status/flag-clean rows and foreign mission linkage.

## Design — one canonical proof, every seam (§1)

The proof helpers are now `BusinessLayer` methods shared by the live
paths AND the restart sweep — no dependency on reconciliation having run
first:

- `missionBoundToWorkItem(row, m)` — `metadata.work_item_id` + `business_id`
  match the row, `source === "business_layer"`, `work_item_open_id`
  present. THE definition of a canonically linked mission.
- `boundMissionForWorkItem(row)` — the row's last mission iff bound.
- `proveReviewAcceptance(row)` — exactly one `WORK_REVIEW_ACCEPTED` with
  `old_state=REVIEW_REQUIRED`, `new_state=DONE`, `reviewer_agent_id`
  present, same-business, non-assignee, named-reviewer match.
- `proveWorkItemDone(row)` — `DONE` only counts when the bound mission is
  `COMPLETED` (plus a valid ACCEPT for `requires_review` rows).
- `quarantineWorkItem(row, detail)` — live equivalent of the sweep's
  quarantine: one `WORK_PROVENANCE_INCONSISTENT` event + `blocked_code=
  TERMINAL_PROVENANCE_CORRUPT`, idempotent.

## §2 live sync mission binding

`syncWorkItem` validates `missionBoundToWorkItem` on the mission it is
about to fold. A foreign/mismatched mission can never: mark DONE, enter
REVIEW_REQUIRED, BLOCK/CANCEL on foreign state, propagate dependencies,
or write success context — the row is quarantined and stays
`IN_PROGRESS` (SYNC-R6-WRONG-WORK, SYNC-R6-WRONG-BUSINESS).

## §3 parent completion proof

`evaluateParentCompletion` requires `boundMissionForWorkItem(parent)`
with status `COMPLETED` before any finalize — foreign, unbound, missing,
RUNNING/FAILED/CANCELLED/PAUSED missions leave the parent parked
(PARENT-R6-UNBOUND-MISSION).

## §4 dependencies/children must be PROVEN, not flag-clean

`depsSatisfiedDeps` and `mandatoryChildrenComplete` now require
`proveWorkItemDone(dep)` in addition to `DONE` + non-corrupt flag. An
ungrounded DONE never satisfies a dependency, never permits a dependent
open, never releases a `CHILD_INCOMPLETE` parent, never contributes to a
cascade — even before any rebuild sweep ran (DEP-R6-UNGROUNDED-DONE-
NO-SWEEP, PARENT-R6-UNGROUNDED-CHILD-NO-SWEEP).

## §5 autoAssign quarantine laundering closed

`WorkforceService.autoAssign` calls `assertWorkItemNotQuarantined` at the
very start — before the no-eligible-agent branch that previously called
`blockWorkItem` and overwrote `blocked_code` with `BLOCKED_CAPABILITY`,
silently clearing `TERMINAL_PROVENANCE_CORRUPT`
(QUAR-R6-AUTOASSIGN: code, status, and event set all unchanged).

## §6 delegation restart repair validates the full row

Before synthesizing a missing `WORK_DELEGATED`, the sweep now requires
ALL of: `delegated_from_work_item_id` resolves to a real parent in the
same business; `delegated_by_agent_id` and `assignee` resolve to agents
of the same business; `delegation_depth = parent.depth + 1 ≤ cap`; the
child id equals the deterministic `WI_DL(parent,key)`; the child's
`parent_work_item_id` agrees. Any failure → quarantine, never an
event manufactured from an invalid row (DELEG-R6-FAKE-ROW,
DELEG-R6-BAD-DETERMINISTIC-ID).

## §7 mission-control actions never touch foreign missions

`blockWorkItem → pauseMission` and `cancelWorkItem → cancelMission` both
gate on `missionBoundToWorkItem`. A corrupted `mission_ids` value can
never pause/cancel mission B through item A (CONTROL-R6-FOREIGN-MISSION).

## R6 focused evidence — 9 new tests (P14: 84/84)

- **QUAR-R6-AUTOASSIGN**: corrupt READY child + autoAssign →
  `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`, code unchanged, no
  `WORK_ITEM_BLOCKED` laundering.
- **SYNC-R6-WRONG-WORK**: A's COMPLETED mission planted as B's last id →
  sync quarantines B, stays IN_PROGRESS, dep stays BACKLOG.
- **SYNC-R6-WRONG-BUSINESS**: cross-business mission → same fail-closed.
- **PARENT-R6-UNBOUND-MISSION**: parked parent + foreign last mission +
  all children DONE legitimately → parent stays `IN_PROGRESS/
  CHILD_INCOMPLETE`.
- **DEP-R6-UNGROUNDED-DONE-NO-SWEEP**: forced DONE without mission →
  `depsSatisfied` false and `openWorkItem` throws
  `FAIL_CLOSED_WORK_ITEM_DEPENDENCY` — no sweep required.
- **PARENT-R6-UNGROUNDED-CHILD-NO-SWEEP**: sibling completes legit while
  another child is forced-DONE → parent stays parked.
- **DELEG-R6-FAKE-ROW**: key/by/to strings but nonexistent parent →
  restart quarantines, zero `WORK_DELEGATED` emitted.
- **DELEG-R6-BAD-DETERMINISTIC-ID**: valid-looking fields but
  `id != WI_DL(parent,key)` → quarantined, no event repair.
- **CONTROL-R6-FOREIGN-MISSION**: planted foreign live mission → block
  does not pause it, cancel does not cancel it; both item transitions
  still complete.

## R6 validation

| gate | result |
|---|---|
| P14 suite | **84/84 PASS** (9 new R6 tests) |
| P13 | 67/67 · P12 71/71 · P11 103/103 · P9 79/79 |
| typecheck | clean · build PASS |
| audit | 0 high / 0 critical |
| Node 22 full | 2007 pass / 2 env P5 probe (CodexCli executable absent — documented env gap) |
| Node 20 full | **2009/0** |
| verifyIntegrity | clean in every quarantine/sync/race/restart test |
| concurrency | all worker_threads races still green (heartbeat one-owner, delegation/review convergence, finalize single-winner) |

All R1–R5 closures unchanged; `PairEvidenceStore.immediate()` remains the
single transaction authority; no second store/router/dispatcher.

Classification: **`P14_REMEDIATED_R6_PENDING_AUDIT`** — DO NOT MERGE.

---

## PROVENANCE REBASELINE — durable canonical binding replaces metadata-as-authority

Independent classification going in:
`P14_R6_INDEPENDENT_AUDIT_BLOCKED` / `STOP_PATCHING` /
`P14_PROVENANCE_REBASELINE_REQUIRED`. This is a foundation rebaseline, not
an R7 hotfix: caller/model-supplied mission metadata may never itself
constitute authority.

### Canonical binding entity: `work_open_binding`

A durable record created by `BusinessLayer` BEFORE `startMission` runs.
One per open intent (`open_id` = PK):

```
{ open_id, work_item_id, business_id, project_id, org_agent_id,
  created_by, mission_id, state, created_at, bound_at, rolled_back_at,
  updated_at, version }
```

- `openWorkItem` mints `missionId = newId("MSN")` up front, writes the
  binding in state `INTENT`, and passes `mission_id` down through
  `startMission` → `createMission` (both now accept an optional pinned
  id; the CAS version-0 insert fails closed on any collision, so a forged
  or pre-existing mission can never claim a binding).
- `startMission` honoring anything else throws `FAIL_CLOSED_MISSION_PIN`.
- The work-item link AND `INTENT → BOUND` flip commit in ONE
  `store.immediate()` — they cannot disagree across a crash window.
- `mission_id` pinning means adoption needs zero metadata scanning: the
  binding IS the authority for which mission this intent was allowed to
  create.

### Binding-driven proof

- `missionBoundToWorkItem(row, m)`: `m.mission_id ∈ row.mission_ids` AND a
  `work_open_binding` exists with `mission_id = m.mission_id`,
  `work_item_id`, `business_id` matching, `state = BOUND`. Mission
  metadata fields are no longer consulted — forged
  `source=business_layer` + copied ids prove nothing.
- `boundMissionForWorkItem`, `proveWorkItemDone`, `proveReviewAcceptance`
  inherit the binding predicate unchanged (same canonical helpers every
  authority seam already calls).
- `reconcileOpenIntent`: binding-only discovery. `BOUND+linked` →
  nothing to repair; `INTENT` + pinned mission exists → adopt atomically
  (link + BOUND + `WORK_ITEM_OPEN_RECONCILED`); `INTENT` + no mission →
  caller grace/rollback path; `BOUND` + mission row missing → quarantine;
  NO binding → nothing may link (legacy intents roll back).
- `resolvePendingOpenBeforeMutation` rollback marks the binding
  `ROLLED_BACK` durably — the decision is idempotent evidence.
- `reviewWorkItem`: after the REVIEW_REQUIRED status check, requires the
  item's bound mission COMPLETED — an ungrounded REVIEW_REQUIRED
  quarantines and fails `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT` for both
  ACCEPT and REWORK.
- Restart delegation repair additionally requires
  `child.required_capability === parent.required_capability` — repair can
  never widen authority.

### Adversarial coverage (7 new tests)

- **BIND-RB-FORGED-METADATA**: direct mission API submission with fully
  forged seam metadata + planted id → `syncWorkItem` quarantines, no fold.
- **BIND-RB-FORGED-NO-LINK**: forged mission claiming the victim open_id
  is never adopted by open-intent reconciliation.
- **BIND-RB-CRASH-ADOPT**: pinned mission exists, link crashed → adopted
  atomically, BOUND, one `WORK_ITEM_OPEN_RECONCILED`, zero dup missions.
- **BIND-RB-CRASH-ROLLBACK**: intent without mission → READY rollback,
  binding ROLLED_BACK, no mission row.
- **REVIEW-RB-UNGROUNDED**: fabricated REVIEW_REQUIRED → ACCEPT + REWORK
  both fail closed, quarantined, no review events.
- **DELEG-RB-CAPABILITY**: delegated child dropping
  `required_capability` → quarantined, no repaired `WORK_DELEGATED`.
- **BIND-RB-HAPPY**: canonical open produces exactly one BOUND binding
  whose mission_id is the row's linked mission; full happy path
  (open → complete → proven DONE) unchanged.

Fixtures updated to stamp the canonical seam shape a real crash always
carries: `makeOrphanPending` (P11-R2) and the fi5 crash-open fixture
(P11-R1) now create the `work_open_binding` INTENT row and pass the
pinned `mission_id` to `startMission`.

### Rebaseline validation

| gate | result |
|---|---|
| P14 suite | **91/91 PASS** (7 new rebaseline tests) |
| P13 | 67/67 · P12 71/71 · P11 103/103 · P9 79/79 |
| typecheck | clean · build PASS |
| audit | 0 high / 0 critical |
| Node 22 full | 2014 pass / 2 env P5 probe (CodexCli executable absent — documented env gap) |
| Node 20 full | **2016/0** |
| verifyIntegrity | clean in every quarantine/sync/race/restart test |
| concurrency | all worker_threads races still green |

All R1–R6 closures unchanged; `PairEvidenceStore.immediate()` remains the
single transaction authority; one canonical MissionRouter/GovernedTaskGate
path; no second store or dispatcher.

Classification: **`P14_PROVENANCE_REBASELINED_PENDING_AUDIT`** —
DO NOT MERGE.
