# PAIR OS vNext — P14 Workforce V2 Phase 3 Report

Scope: PARENT/CHILD COMPLETION + REVIEW/ACCEPTANCE + RESTART-SAFE
FINALIZATION/RECOVERY — the lifecycle layer that closes the governed
workforce loop on top of Phase 1 graph authority (WGM/WDEL/WDEC/WDS/WGE/
WAB/ACR) and Phase 2 coordination (WCL/WFM/WIR).

Central invariant implemented: **no work item becomes canonically
complete because a mutable status field says DONE/COMPLETED. Completion
authority derives only from canonical evidence.**

This document is evidence, not proof. GitHub source is authority.

## 1. Exact base SHA
`1add96dd4cc6b47cb8ab85e1d6f50970dd077fbc` (merge commit of PR #13,
P14 WFV2 Phase 2 — user-merged).

## 2. Exact branch
`devin/1790756068-p14-wfv2-p3`

## 3. Exact head SHA
(filled at push — see PR)

## 4. PR number
(see final message / PR)

## 5. Changed files
- `src/pair/work-completion.ts` — NEW. WCP entity + validator + canonical
  child-set derivation + completion digest.
- `src/pair/business.ts` — completion seams (finalize/review/cascade/
  reconcile), `proveWorkItemDone` upgrade, `WORK_ITEM_TRANSITIONS`
  extended with the finalize-seam-only DONE/REVIEW_REQUIRED targets.
- `src/pair/work-graph.ts` — `reconcileWorkGraph` tail-calls
  `reconcileWorkLifecycle`.
- `src/pair/mission-control-server.ts` — `POST /api/work-items/:id/review`
  and `GET /api/work-items/:id/completion`.
- `src/pair/index.ts` — export work-completion module.
- `src/__tests__/pair-p14-wfv2-p3.test.ts` — NEW, 28 tests.
- `PAIR_OS_VNEXT_P14_WORKFORCE_V2_PHASE3_REPORT.md`, `CURRENT_STATE.md`.

## 6. Canonical completion design (§4)
`work_completion` row `WCP_<work_item_id>` — deterministic id, COMMITTED,
written only inside the same `immediate()` transaction that projects the
item DONE. Fields: `work_item_id, business_id, mission_id,
bound_open_id, child_work_item_ids, reviewer_agent_id` (nullable pins) +
`child_set_digest` + `completion_digest` (sha256 over the exact pin
fields) + `project_id`. Exactly-one `WORK_ITEM_COMPLETED` event on the
`work_completion` entity anchors every pin — the row can be
re-materialized after row loss only if the surviving anchor matches the
deterministic pins (adopted, never duplicated).
`assertCanonicalWorkCompletion` proves, in order: deterministic id,
COMMITTED, item exists + DONE + not corrupt-marked, business/project
match, `completion_digest` and `child_set_digest` recompute over stored
payload, exactly-one matching anchor, bound-mission completion chain
(see §4 rule 5–10 below), canonical child-set recursion (each pinned
child must itself hold a validating WCP — depth-capped at 64), and the
review pin (below).
Bound-mission proof: last `mission_ids` entry === pinned mission, mission
COMPLETED, `mission.bound_open_id` === pinned `bound_open_id`, the
`work_open_binding` passes `validateWorkOpenBinding(..., PROVENANCE)`
(pinned item + business + project + binding state BOUND). No second live
or replacement mission is accepted: a mission bound to a different item
or a different open intent fails the chain.
`proveWorkItemDone` (the only dependency-satisfaction oracle) returns
boolean — it never reads `status`, `result_summary`, mutable
`mission_ids` ordering alone, caller input, workforce messages, leases,
or operator "completed" flags.

## 7. Review design (§5)
`requires_review` items fold to `REVIEW_REQUIRED` (no WCP) when their
canonical basis is ready — review is a gate, never auto-accept.
`reviewWorkItem` (single seam, service-owned):
- re-reads the row inside the txn; requires `REVIEW_REQUIRED` — an
  ACCEPT and a REWORK racing produce exactly one canonical outcome
  (second committer sees non-REVIEW_REQUIRED and fails).
- grounding = `completionBasisSafe` (bound-mission-completed OR all
  canonical children complete) — a REVIEW_REQUIRED row without basis is
  ungrounded and quarantined by reconcile.
- reviewer must be a same-business ACTIVE org_agent, not the assignee,
  and must match `reviewer_agent_id` when the item names one.
- ACCEPT writes, in one txn: WCP (reviewer-pinned) + DONE projection +
  exactly-one `WORK_REVIEW_ACCEPTED` event pinning `reviewer_agent_id,
  decision, mission_id, bound_open_id, child_set_digest,
  completion_digest`. The event's `completion_digest` is the digest of
  the WCP it authorizes — a replayed/duplicate ACCEPT whose candidate
  digest equals the pinned digest emits no second event; a DONE row
  with a valid WCP replaying ACCEPT under the same reviewer returns the
  row idempotently; a different reviewer on DONE fails
  `FAIL_CLOSED_WORK_REVIEW_STATE`.
- REWORK projects the item back to READY (history preserved), clears the
  execution mirrors, and requires the *next* completion to come through
  a new bound mission — the old completion proof is never reused (the
  new WCP pins the new mission/bound_open_id, so the old ACCEPT event
  cannot anchor it).

## 8. Parent aggregation design (§7/§8)
The canonical child set is `canonicalChildIdsOf`: COMMITTED+validated
WDEC (`child_work_item_ids`) ∪ COMMITTED+validated WDEL
(`parent_work_item_id`), sorted unique — never mutable
`child_work_item_ids`/`parent_work_item_id` mirrors.
`evaluateParentCompletion` on each canonical parent: all pinned children
must themselves prove canonical completion; a parent with its own bound
mission additionally requires that mission completed (mixed executable/
container parents cannot be completed by children alone). A
`requires_review` parent projects REVIEW_REQUIRED once its basis is
ready; otherwise it finalizes. `advanceCompletionCascade` walks parents
via `canonicalParentIdsOf` (WDEL back-edge + WDECs listing the child)
with a seen-set cycle guard — each parent evaluated in its own txn;
progressed parents enqueue upward so the cascade is bounded, evidence-
driven, and idempotent.

## 9. Dependency completion semantics (§9)
`assertDependenciesSatisfied` consumes `proveWorkItemDone` — only
canonical completion satisfies a dependency edge. Status text,
mission-terminal-without-binding, claim release, heartbeat expiry,
message ACK, review requests, and manual edits satisfy nothing.

## 10. Restart/finalization design (§10/§15)
`reconcileWorkLifecycle` (invoked at the end of `reconcileWorkGraph`,
i.e. on every boot) covers crash boundaries A–F:
1. sweeps every `work_completion` row through the canonical validator —
  a malformed/forged WCP quarantines its owner item (never deleted,
  never healed by guess).
2. IN_PROGRESS items re-run the `syncWorkItem` fold — a bound mission
   that reached a terminal state while the server was down finalizes now
   (boundary A).
3. non-terminal items with a non-empty canonical child set are
   re-evaluated for parent aggregation (boundaries B/E).
4. REVIEW_REQUIRED rows: ungrounded → quarantine; grounded + a matching
   ACCEPT event → the pinned WCP/DONE are materialized exactly once by
   recomputing the candidate fields and comparing `completion_digest`
   to the event pin (boundary C). A DONE row without a WCP gets the WCP
   materialized iff the basis proves out — including the review pin
   when required — otherwise the row is quarantined (boundary D).
No duplicate missions, evidence, reviews, or completions are created;
canonical completion is never downgraded; nothing is fabricated.

## 11. Concurrency model (§11/§17)
All lifecycle mutations happen inside `store.immediate()` on a single
sqlite database — BEGIN IMMEDIATE serializes writers; the in-txn
canonical re-read plus CAS is the authority. Worker-thread race tests
use independent connections synchronized on an `Atomics` barrier over
the same DB file. Observed: exactly-one canonical winner or idempotent
convergence — no caller-side stale row is re-armed (Phase-2 precedent
preserved: resync only the fields the gate itself owns).

## 12. Provenance/event anchors (§6)
`WORK_ITEM_COMPLETED` (on the `work_completion` entity) pins
`work_item_id, completion_digest, mission_id, bound_open_id,
child_set_digest, reviewer_agent_id`. `WORK_REVIEW_ACCEPTED` (on the
`work_item`) pins `reviewer_agent_id, decision, mission_id,
bound_open_id, child_set_digest, completion_digest`. Deterministic ids
(`WCP_<wid>`) + recompute-over-stored digests + append-only anchors make
row mutation, replacement, digest recompute, wrong-item/parent/child/
mission/binding pins, duplicate acceptance, forged finalization and
replay all detectable — each fails closed via
`FAIL_CLOSED_WORK_PROVENANCE_CORRUPT` or `FAIL_CLOSED_WORK_REVIEW_STATE`.

## 13. Fail-closed behavior (§22 self-audit)
- status-only completion → never proves; a forged DONE without provable
  basis is quarantined by reconcile.
- WCP tamper (wrong mission pin, rehashed digest, missing/mismatched
  anchor, forged review pin) → validator throws → read/proof seams fail.
- missing receipt-style analogue: a missing WCP blocks completion proof
  (absence is not evidence).
- corrupt child WCP blocks the parent — child set is re-derived live and
  every pinned child must validate.
- completion-vs-cancellation, ACCEPT-vs-REWORK, finalize-vs-reconcile,
  two finalizers, two cascades, dep-open-vs-finalize — all close to one
  canonical outcome.
- coordination (claim/heartbeat/message/HANDOFF) carries zero
  completion authority — verified by direct tests.
- no "helpful recovery": reconcile materializes only what prior
  canonical transactions already proved; it never invents completion,
  missions, reviews, edges, membership, or reassignments (§15
  MUST-NOTs hold).

## 14. Test results
`src/__tests__/pair-p14-wfv2-p3.test.ts`: **28/28 pass** (27 mandated
names covered: CHILD-COMPLETION-REQUIRES-CANONICAL-BINDING,
STATUS-ONLY-COMPLETION-REJECTED, WRONG-MISSION-BINDING-REJECTED,
COMPLETION-TAMPER-REHASH-FAILS, REVIEW-REQUIRED-NOT-AUTO-ACCEPTED,
REVIEW-ACCEPT-CANONICAL, REVIEW-ACCEPT-IDEMPOTENT,
REVIEW-FORGED-DECISION-FAILS, ACCEPT-REWORK-RACE-SINGLE-CANONICAL-OUTCOME,
REWORK-DOES-NOT-REUSE-OLD-COMPLETION-AUTHORITY,
PARENT-WAITS-FOR-ALL-REQUIRED-CHILDREN, PARENT-USES-CANONICAL-CHILD-SET,
FOREIGN-CHILD-CANNOT-SATISFY-PARENT,
DEPENDENCY-STATUS-ONLY-DOES-NOT-SATISFY,
DEPENDENCY-CANONICAL-COMPLETION-SATISFIES, COMPLETION-CASCADE-IDEMPOTENT,
CONCURRENT-FINALIZER-SINGLE-EVIDENCE, RESTART-AFTER-MISSION-COMPLETE-
BEFORE-FINALIZE, RESTART-AFTER-CHILD-FINALIZE-BEFORE-PARENT-CASCADE,
RESTART-AFTER-REVIEW-ACCEPT-BEFORE-PROJECTION,
RECONCILE-DOES-NOT-DUPLICATE-MISSION, RECONCILE-DOES-NOT-FABRICATE-REVIEW,
HEARTBEAT-DOES-NOT-PROVE-COMPLETION, MESSAGE-DOES-NOT-PROVE-COMPLETION,
HANDOFF-DOES-NOT-MUTATE-COMPLETION-AUTHORITY,
GRAPH-ASSIGNEE-IMMUTABILITY-PRESERVED, CORRUPT-PROVENANCE-FAILS-CLOSED —
plus FINALIZE-VS-RECONCILE, DEP-OPEN-VS-FINALIZE, TWO-PARENT-CASCADES,
COMPLETION-VS-CANCELLATION races).

## 15. Full regression results
- P14-P2 suite: 55/55 · P14 WFV2 Phase1: 73/73 · P14 Foundation V2:
  35/35 · Runtime hardening: 11/11 · P13: 67/67 · P12: 71/71 ·
  P11+remediations: 103/103 · P10: 31/31 · P9: 79/79 · P6: 36/36.
- Node22 full suite: 2125 pass + 2 fail — both are the pre-existing P5
  environment-gap failures (codex executor availability), identical to
  every prior phase.
- Node20 full suite: 2127 pass / 0 fail.
- `tsc --noEmit`: clean. `pnpm build`: PASS. `pnpm audit
  --audit-level=high`: 0 high (1 low + 8 moderate, pre-existing).
  `verifyIntegrity` exercised inside the suites.

## 16. Fresh E2E evidence
`PAIR_MC_DIR=<fresh>` real server, real HTTP API, two restarts.
`e2e-p14-p3.mjs` — 24/24 checks:
- A–D: business + 3 agents; parent decomposed into c1/c2(review)/c3 via
  canonical WDEC; dep item gated `FAIL_CLOSED_WORK_DEPENDENCY_UNMET`
  before c1.
- E–I: c1 open → binding → mission → terminal success → DONE + WCP
  (mission pin MSN_01M3RR5JT8A7J3XVV3MZGYF3HR); parent stays READY; dep
  then opens on canonical completion.
- J–K: c2 folds REVIEW_REQUIRED with no WCP; parent blocked; ACCEPT by
  reviewer → DONE + WCP pinned to reviewer; replay idempotent; exactly
  one WORK_REVIEW_ACCEPTED event; parent still waits on c3.
- L–M: c3 opened + mission completed, server killed *before* the fold —
  restart's `reconcileWorkLifecycle` finalized c3 exactly once and the
  cascade completed the parent with pinned child set {c1,c2,c3}.
- N: every completed item has exactly 1 anchor + 1 WCP + 1 mission + 1
  binding; the container parent has a WCP with 0 missions/0 bindings.
- O: claim+heartbeat+HANDOFF_REQUEST on the IN_PROGRESS dep item prove
  nothing (no WCP, still IN_PROGRESS); a second restart produces zero
  duplicate evidence.

## 17. Known limitations
- Completion cascade is driven by mutation seams + reconcile; there is
  no separate daemon — a parent whose last evidence lands while the
  server is down finalizes at the next boot reconcile (by design).
- `COMPLETION_DEPTH_CAP = 64` bounds recursive child-set validation.
- The two Node22 failures are the long-standing P5 environment-gap
  (missing codex/dsh executables), unchanged by this phase.

## 18. Explicitly deferred functionality
Phase 4, P15, P16, Strategic Brain Layer, CEO Agent — untouched.
Automatic redispatch/reassignment remains unimplemented by design;
review REWORK requires a new canonical open for a new attempt.

## 19. P15/P16 untouched
No P15/P16/Phase-4 code was created or modified; no strategic-brain or
CEO agent surfaces exist. Scope stayed inside the P14 WFV2 Phase-3
lifecycle mandate.

Classification: **P14_WORKFORCE_V2_PHASE3_PENDING_INDEPENDENT_AUDIT**
