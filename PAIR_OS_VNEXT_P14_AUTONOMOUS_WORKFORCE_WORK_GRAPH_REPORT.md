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
