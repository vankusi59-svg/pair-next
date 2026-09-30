# PAIR OS vNext — P14 Workforce V2 FINAL CLOSURE Report

Scope: FINAL cross-phase closure audit + hardening over the COMPLETE
integrated Workforce V2 stack (Phase 1 graph authority + Phase 2
coordination + Phase 3 completion lifecycle). This is NOT Phase 4 — no
new major features, no architecture redesign, no P15/P16, no merge.

This document is evidence, not proof. GitHub source is authority.

## 1. Exact canonical base SHA
`6f389c91aabf14768d09912f1efc3d962fb1ec4a` (merge commit of PR #14 —
the independently audited P14 WFV2 Phase 3 R4 PASS implementation).

## 2. Exact branch
`devin/1790765918-p14-final-closure`

## 3. Exact head SHA
(filled at push — see PR)

## 4. PR number
(see final message / PR)

## 5. Changed files
- `src/pair/business.ts` — routine-mirror authority boundary fix
  (`syncRoutineMirror` seam, `reconcileWorkLifecycle` routine-DONE
  branch, `syncRoutineWorkItems` proof-gated projection).
- `src/__tests__/pair-p14-wfv2-p3.test.ts` — 5 new `P14-FC-ROUTINE-*`
  tests + helpers (`fireRoutineMission`, `routineItems`, `makeRoutine`).
- `src/__tests__/pair-p9.test.ts` — routine fixture upgraded to
  canonical completion evidence (a raw `status:"COMPLETED"` row is a
  forgery under the R4 schema; fixture now runs
  `canonicallyCompleteMission` on a real `startMission`).
- `CURRENT_STATE.md`, `PAIR_OS_VNEXT_P14_FINAL_CLOSURE_REPORT.md` (this
  document).

**Code remediation was required: YES — exactly one defect (§8).** No
other defects found in the cross-phase audit; no remediation work was
manufactured.

## 6. Integrated P14 architecture

Single execution path (verified in source, unchanged):

```
work item
  → BusinessLayer.openWorkItem                (claim/assignee/dep gates)
  → work_open_binding (INTENT, pins mission_id)
  → MissionControl.startBoundMission          (binding PROVENANCE then ADMISSION)
  → PairControlPlane.startMissionInternal     (bound_open_id pin, contract pin)
  → Planner (template | llm_plan via planExpander)
  → MissionRouter                             (adopt-vs-dispatch, contract filtering)
  → GovernedTaskGate                          (create_governed_task, dispatch authorize)
  → MissionRuntime / executor                 (INTENT→EXEC rows, validation, TASK_COMPLETED)
  → canonical completion fold (syncWorkItem → WCP or REVIEW_REQUIRED)
```

No second planner, router, scheduler, runtime, execution authority, or
completion authority exists. `syncRoutineWorkItems` is a *projection*
(mission → board mirror), not an execution path — see §8.

## 7. Authority matrix

| Concern | Phase | Canonical authority | Never authority |
|---|---|---|---|
| Graph structure | P1 | WGE edges + WDEC/WDEL rows (COMMITTED, validated) | work_item.parent_id mirrors, events alone |
| Membership/ceiling | P1 | work_graph_membership + WAB anchored binding (highest revision) | cached/claimed ceilings |
| Assignee | P1 | work_item.assignee_agent_id immutably bound once graph-governed | messages, HANDOFF, heartbeat |
| Open/execute | P1+F | work_open_binding INTENT→BOUND via openWorkItem only | mission_ids array, metadata |
| Dependency | P1+P3 | assertDependenciesSatisfied over canonical child set + WCP proofs | status text, `dependenciesProven` read-model |
| Claim/exclusion | P2 | work_claim_lease (CAS, epoch, token digest, hb<exp ordering) | claimed_by mirror fields |
| Messages | P2 | WFM SENT anchor + WIR receipt + exactly-one ACK | inbox projections |
| Mission completion | P3 | assertCanonicalMissionCompletion: mission transition + MRT + plan manifest (pinned digest, revision bijection) + per-task governed chain (GT/INTENT/EXEC/validation PASS/RESULT_VALIDATED/TASK_COMPLETED) | mission.status, result fields |
| Work completion | P3 | WCP_<wid> + exactly-one WORK_ITEM_COMPLETED anchor pinning mission/open/children/reviewer + digest recompute | DONE status, receipts |
| Review | P3 | REVIEW_REQUIRED ← requires_review; ACCEPT/REWORK inside one txn with in-txn reviewer re-proof; REWORK basis fence | a second ACCEPT, stale basis |
| Aggregation | P3 | parent folds only over canonical child set (WDEC∪WDEL); mixed parent needs own bound mission | non-canonical children |
| Reconcile | all | rebuilds mirrors from canonical evidence; quarantines TERMINAL_PROVENANCE_CORRUPT; never fabricates | — |

## 8. Defect found + remediation (the only one)

**Defect**: P11 `syncRoutineWorkItems` projects schedule-fired missions
onto `work_item` rows directly (`source:"routine"`, `routine_id` set,
unbound `mission_ids`). These mirrors can never have a
work_open_binding, membership, or WCP — by design. The P3 completion
seams treated them as corrupt:
- `syncWorkItem`: any item whose last mission is unbound → quarantine
  → every IN_PROGRESS routine mirror self-poisoned on the next board().
- `reconcileWorkLifecycle`: DONE-without-WCP → quarantine → every
  completed routine mirror self-poisoned.

Pre-fix observable: a routine mission legitimately completes → mirror
invents itself as corrupt; `board()` shows the business's routine
output as permanently corrupt. That is a real behavioral defect in the
integrated stack (P11 observability × P3 authority seam interaction).

**Fix (narrow root cause, no redesign)**: routine mirrors are
*mission-status mirrors*. They are honest iff they replicate the
mission's own canonical state:

- `syncRoutineMirror` (new seam): maps mission status → mirror status
  (COMPLETED→DONE, FAILED/PAUSED→BLOCKED, CANCELLED→CANCELLED, else
  in-flight). DONE requires `proveCanonicalMissionCompletion` on that
  exact mission — an unproven terminal claim quarantines. Releases the
  ACTIVE lease on terminal fold inside the same `immediate()`.
- `reconcileWorkLifecycle`: a `routine_id` DONE mirror validates via
  mission proof instead of the WCP ledger path; unproven → quarantine.
- `syncRoutineWorkItems` projection: unproven `COMPLETED` projects
  IN_PROGRESS — the same-render fold then quarantines the forged
  mirror (fail-closed at write AND at fold).
- Mirrors NEVER mint `work_completion` records. They carry zero
  work-item completion authority: the dependency oracle still rejects
  them as providers, they cannot satisfy edges, cannot enter review,
  and do not aggregate into parents. A *reopened* routine item (bound
  via openWorkItem) goes through the canonical bound path and CAN mint
  a real WCP — authority enters only through the binding.
- Unbound *non-routine* links still quarantine on ALL statuses —
  the P3 leniency is not relaxed for anything else.

Regression tests: `P14-FC-ROUTINE-INPROGRESS-NOT-QUARANTINED`,
`ROUTINE-COMPLETED-MIRROR-HONEST`, `ROUTINE-FORGED-DONE-QUARANTINES`,
`ROUTINE-FAILED-MIRRORS-BLOCKED`, `ROUTINE-REOPEN-BOUND-COMPLETES-CANONICALLY`
(P3 suite 73/73).

**Why not BLOCKED**: the fix preserves the exact P3 authority model —
no new authority source was added; mirrors were narrowed to honest
projections rather than granted item-level completion semantics. No
architectural redesign required.

## 9. Cross-phase audit checklist (all other seams verified clean)

- Phase 2 coordination granting Phase 3 authority: NO — claim/lease,
  heartbeat, messages, receipts, ACKs are never consumed by any
  completion seam; verified by negative proofs below + source (no
  completion path reads WCL/WFM/WIR).
- Status/projection vs canonical evidence: closed at every seam
  (dependency oracle, review gate, WCP mint, reconcile, routine mirror).
- Mirror vs canonical graph: child set derives from COMMITTED+validated
  WDEC∪WDEL only; `dependenciesProven` is read-model only.
- Mutable row vs immutable provenance: plan manifest + task_ids pinned
  in MISSION_PLAN_COMMITTED (digest recomputed); WCP anchored;
  REWORK event self-consistent (R2).
- Stale-read TOCTOU / CAS re-arming: all admission decisions re-read
  canonical state inside the committing `immediate()` txn (claim,
  open, review ACCEPT/REWORK, assign); CAS conflicts collapse to one
  winner, loser fails closed.
- Omission-safe sets: declared↔live task set equality + commit-anchor
  digest; revision history bijection (highest committed = active).
- Duplicate dispatch/completion/review: intent id `INTENT_<gt>` +
  `EXECUTION_PERSISTED` adoption; WCP deterministic id +
  exactly-one anchor; replayed ACCEPT idempotent.
- Restart partial-state ambiguity: reconcile distinguishes
  INTENT/committed/rolled-back bindings, resumes finalize at every
  boundary, quarantines ungrounded DONE/REVIEW_REQUIRED/WCP.
- Reconciliation fabrication / authority drift after restart: reconcile
  never fabricates evidence (malformed → quarantine), ceiling/agent
  re-derived from canonical rows.
- Graph-bound assignee mutation: FAIL_CLOSED_WORK_GRAPH_ASSIGNEE_IMMUTABLE.
- Plan revision rollback / manifest shrink/reorder/expand: R4 closures.
- Stale completion basis reuse: REWORK rejected-basis fence +
  advanced-basis unfence (R1/R2).

## 10. Golden E2E (44/44, real `dist/` server, fresh dir, 6 restarts)

Topology: Parent(lead) ├── A(lead) ├── B(lead, dep A) ├──
C(w2, requires_review) ├── D(lead, dep B+C) └── E(delegated to w2).

- Canonical decomposition (WDEC `D-FC-1`, sibling DAG via
  `depends_on_indices`, `requires_review`) + canonical delegation
  (WDEL `E`) — parent child set = 5 (WDEC∪WDEL).
- claim A + heartbeat (token-verified).
- A openWorkItem → binding BOUND → mission `bound_open_id` pin →
  governed completion evidence → restart → DONE+WCP, exactly-1 anchor.
- B eligible only after A; C → REVIEW_REQUIRED (no WCP) → ACCEPT by
  named reviewer → DONE+WCP; D eligible only after B+C; E delegated.
- Parent aggregates all 5 children → DONE+WCP.
- Restart boundaries A–E all clean: no duplicate mission/binding/
  dispatch/WCP/ACCEPT/anchor; no fabricated authority.
- Negatives proven live: heartbeat≠dependency, ACK≠completion,
  HANDOFF≠authority (non-assignee claim rejected), DONE-without-WCP≠
  dependency (rejected + quarantined at restart), forged mission
  completion≠work completion (quarantine), reopen-DONE fails,
  concurrent opens → exactly 1 mission.
- Routine mirror E2E-verified non-quarantined (fix verification).
- Store-wide exactly-once sweep: 6 WCPs (5 children+parent), 0 dup
  anchors, 0 missing WCP on non-corrupt DONE, exactly-1 ACCEPT.

## 11. Restart/recovery result

6 restarts at boundaries A–E + final post-forge reconcile: every
boundary converged to exactly one canonical state; forged DONE
quarantined at boot; zero duplicate evidence anywhere.

## 12. Concurrency result

- Unit suites carry the genuine worker_threads races (P1-R*: assign/
  claim atomic txn, decompose/claim atomicity; P2-R1: claim vs
  heartbeat, assign vs heartbeat inverse, project revoke; P3:
  ACCEPT vs REWORK, ACCEPT vs reviewer PAUSE/TERMINATE, concurrent
  finalizers, final-child vs parent aggregation, reconcile vs
  finalize). All preserved green: 634/634 focused.
- E2E-live concurrent opens on the same item: exactly 1 mission, 1
  binding, loser gets 409.
- All races converge to one canonical result or an equivalent
  idempotent state.

## 13. Validation matrix

| Suite | Result |
|---|---|
| `pair-p14-wfv2-p3` | 73/73 |
| `pair-p14-wfv2-p2` | 55/55 |
| `pair-p14-workforce-v2` (Phase1+RB) | 73/73 |
| `pair-p14-foundation` | 35/35 |
| `pair-runtime-hardening` | 11/11 |
| `pair-p13` | 67/67 |
| `pair-p12` | 71/71 |
| `pair-p11` + r1–r6 | 91/91 |
| `pair-p10` | 31/31 |
| `pair-p9` | 79/79 |
| `pair-p6` | 36/36 |
| **Focused total** | **634/634** |
| Node 22 full | 2170 pass, 2 fail — identical pre-existing P5 env-gap (DSH + CODEX executables absent on dev box; unchanged, pass on CI) |
| Node 20 full | 2172/0 |
| `tsc --noEmit` | clean |
| `pnpm build` | PASS |
| `pnpm audit` | 0 high (1 low, 8 moderate — transitive esbuild/tsx advisories, pre-existing) |
| `verifyIntegrity` | PASS (hash-chain sweep on fresh populated store) |
| Golden E2E | 44/44 |

## 14. Known limitations (maintenance-level residual risk)

- `PAIR_MC_TOKEN` unset = open local mode (documented since P9; local
  single-operator scope).
- Direct privileged rewriting of ALL SQLite rows + hashes + events
  consistently is outside the P14 threat model (mandate §4) — the
  store detects inconsistency forgeries, not an attacker rewriting
  the universe consistently.
- P5 env-gap: DSH/CODEX probe tests assume the executables are absent;
  on this dev box they fail (unchanged since P11, documented).
- LLM planner path (`llm_plan`) exercised via metadata passthrough +
  sanitized re-check; live LLM calls not exercised in E2E (no provider
  creds on the box) — the canonical persisted shape is identical.
- GLM-5.3 NIM qualification deferred (planner timeout env patch — not
  part of this closure mandate).

## 15. Deferred (explicitly NOT in this closure)

P15 (KPI gap analysis), P16 (CEO agent), Phase 4 workforce lifecycle
features, CEO Agent, Strategic Brain Layer — all intentionally
deferred per mandate.

## 16. Convergence assessment

P14 has CONVERGED:
- no competing authority layer (single path §6 verified, mirrors
  narrowed to projections-only);
- no unresolved systemic defect (the one genuine cross-phase defect —
  routine mirrors — is fixed at the root with 5 regression tests);
- Phase 1/2/3 invariants compatible (full matrix green);
- R1–R4 remediations remain valid (all R* tests preserved green);
- no escalating remediation chain — the FC defect is a projection-
  semantics fix, not another authority patch;
- residual risk is maintenance-level only (§14).

## 17. Classification

**`P14_WORKFORCE_V2_FINAL_CLOSURE_PENDING_INDEPENDENT_AUDIT`**

Not OFFICIAL_FINAL — that requires the independent audit of this PR.

## 18. FC R1 remediation — canonical routine provenance + promotion membership

Independent audit of this PR classified BLOCKED — R1 REQUIRED on two
routine-boundary defects. Both closed narrowly; zero redesign of
Planner/Router/Gate/Runtime/WCP/graph authority.

### 18.1 BLOCKER 1 — routine identity now comes ONLY from canonical
schedule evidence

**Defect**: `syncRoutineWorkItems` discovered routine runs from caller-
settable mission metadata (`metadata.schedule_id`/`business_id`) — an
ordinary `startMission` could claim a routine's schedule_id and project
a mirror. Tests manufactured exactly that forgery.

**Fix**: one validator — `assertCanonicalRoutineMirror` /
`assertCanonicalRoutineFire` (new `src/pair/routine-mirror.ts`) — proves
the FULL canonical chain and nothing else:

```
routine row (exact, business match)
→ mission_schedule row (routine.schedule_id, project/business scope)
→ mission metadata.schedule_occurrence_id
→ schedule_occurrence row: schedule_id match, status=FIRED,
  mission_id == exact mission
→ mission metadata 4-pin: schedule_id, schedule_occurrence_id,
  scheduled_for == occurrence.due_at, business scope
→ schedule_digest recomputable (goal/cron immutable post-create)
→ exactly-one SCHEDULE_FIRED anchor: entity=schedule_id,
  correlation=mission_id, metadata {mission_id, occurrence_id,
  scheduled_for} all pinned
→ mirror identity: source="routine", WI_RT_<digest(mission)>
  deterministic id, mission_ids[0] == projected fire mission,
  WORK_ITEM_CREATED event agrees
```

Every routine-exception seam consumes the same validator:
`syncWorkItem` (unbound branch), `syncRoutineMirror` (entry),
`reconcileWorkLifecycle` (routine-DONE branch), `openWorkItem`
promotion path, `syncRoutineWorkItems` projection itself
(`assertCanonicalRoutineFire` gate — a non-canonical claimant simply
does not project). Invalid provenance → `TERMINAL_PROVENANCE_CORRUPT`
quarantine, never silent.

**Forgeable test path removed**: all happy-path routine fixtures drive
the real `createRoutine → next_due_at due → MissionScheduleService.
fireDue → schedule_occurrence claim → governed startMission → FIRED
binding → SCHEDULE_FIRED anchor` chain (shared
`fireRoutineMission` in `canonical-mission-completion.ts`). Four legacy
fixtures that simulated fires via caller metadata were upgraded
(p9, p11, p11-r1, p11 §2.E ×2).

### 18.2 BLOCKER 2 — reopened mirrors enter Phase-1 graph authority

**Defect**: mirror rows had no `work_graph_membership`; a mirror could
cross `openWorkItem` → binding → WCP with zero Phase-1 authority.

**Fix (projection-time membership, mandate's alternative-B)**: mirror
row + deterministic STANDALONE `work_graph_membership` (`WGM_<digest>`)
commit atomically in the same `immediate()` at projection. PLUS a
promotion gate inside `openWorkItem` (before any open intent/binding/
mission exists): `promoteRoutineMirror` — proves
`assertCanonicalRoutineMirror`, then re-validates the existing WGM via
`assertCanonicalMembership` inside the txn (a tampered/fabricated row
fails closed); missing membership (legacy mirror) is written
deterministically; a CAS-loser re-reads + validates the winner row.
Exactly one canonical membership ever exists; restart idempotent;
cross-connection safe; no WDEL/WDEC/WDS/WAB is ever fabricated. A
provenance-broken mirror is quarantined by the same path, never
promoted. `assertGraphAuthority` was NOT weakened — the WGM is a
normal canonical membership.

A DONE mirror stays display-only (zero WCP forever); a mirror whose
scheduler run FAILED/BLOCKED may reopen via the normal bound path —
promotion → openWorkItem → work_open_binding → governed mission → real
WCP — all pinning the same work item/business/project.

### 18.3 R1 tests (15 new, P3 suite 88/88)

Provenance: `P14-FC-R1-CALLER-SCHEDULE-METADATA-CANNOT-FORGE-ROUTINE`,
`-ROUTINE-REQUIRES-FIRED-OCCURRENCE`, `-OCCURRENCE-MISSION-MISMATCH-
FAILS`, `-ROUTINE-SCHEDULE-MISMATCH-FAILS`, `-SCHEDULE-FIRED-EVIDENCE-
MISMATCH-FAILS`, `-ROUTINE-WORK-ITEM-ID-PIN-FAILS`, `-MUTABLE-ROUTINE-
ID-CANNOT-BYPASS-UNBOUND-QUARANTINE`, `-MISSION-ID-SWAP-CANNOT-BYPASS-
ROUTINE-PROVENANCE`, `-GENUINE-SCHEDULE-FIRE-PROJECTS-HONEST-MIRROR`.
Membership: `-ROUTINE-MIRROR-ZERO-AUTHORITY-BEFORE-PROMOTION`,
`-ROUTINE-REOPEN-REQUIRES-CANONICAL-MEMBERSHIP`, `-ROUTINE-PROMOTION-
CREATES-EXACTLY-ONE-WGM`, `-ROUTINE-PROMOTION-RESTART-IDEMPOTENT`,
`-ROUTINE-PROMOTION-CONCURRENT-SINGLE-MEMBERSHIP`, `-REOPENED-ROUTINE-
COMPLETES-WITH-WGM-BINDING-WCP`.

### 18.4 R1 E2E additions (Golden FC E2E now 53/53)

`FC-R1 caller-metadata forgery does not project` (mission created, zero
mirrors) → `genuine fire binds occurrence FIRED` → `canonical mirror
projected (WI_RT + STANDALONE WGM)` → `DONE mirror zero WCP` → restart
→ `mirror honest` → `second occurrence fired+bound` → `failed run
mirrors BLOCKED` → `promotion → canonical WGM + bound mission` →
`reopened routine completes with WGM→binding→WCP` → restart →
`zero-dup (1 mirror each, 1 WGM, 1 binding, 1 WCP)`. Prior 44 checks
preserved verbatim.

### 18.5 R1 convergence reassessment

Both defects closed WITHOUT redesigning Planner, MissionRouter,
GovernedTaskGate, MissionRuntime, WCP, or graph authority: routine
identity is now a projection-consuming read of ALREADY-canonical
schedule evidence, and promotion reuses the existing Phase-1
membership model. Convergence declaration stands.

## 19. R1 classification

**`P14_WORKFORCE_V2_FINAL_CLOSURE_R1_PENDING_INDEPENDENT_AUDIT`**

## 20. Remediation R2 — routine mission-lineage closure

Independent audit of R1 classified
`P14_WORKFORCE_V2_FINAL_CLOSURE_R1_FINAL_INDEPENDENT_AUDIT_BLOCKED`:
the routine validator proved `mission_ids[0]` while authority seams
consumed `mission_ids[last]` — a foreign terminal mission id appended
to a mirror could (a) drive `syncRoutineMirror` state folds and
(b) hide a still-live scheduler/bound mission from `openWorkItem`'s
active-mission gate, violating "no replacement execution while linked
canonical work is live".

### 20.1 Design — ONE canonical routine mission-lineage proof

`routine-mirror.ts: assertCanonicalRoutineLineage(store, item)`
consumes the R1 mirror proof for `mission_ids[0]` and then enforces
exactly two legal shapes:

- **A. Display-only mirror** — `mission_ids` is exactly
  `[projected_scheduler_mission]`; every exception seam that honours
  the routine path additionally requires `last == mids[0]` (and
  `mids.length === 1`), so a trailing foreign id can never reach
  `syncRoutineMirror` or the DONE-fold in `reconcileWorkLifecycle`.
- **B. Promoted/reopened item** — `mids[0]` stays the projected
  mission; every trailing id must be a canonical bound attempt of the
  SAME item: mission row exists, `mission.bound_open_id` resolves to
  a `work_open_binding` that validates under
  `validateWorkOpenBindingById(..., {forWorkItem, forMission,
  requireState:"BOUND", mode:"PROVENANCE"})` — exact work item /
  exact mission / same business / same project, BOUND state,
  `bound_open_id` origin — and `bound_at` order is non-decreasing
  (history order consistent with canonical open history). A
  `WORK_ITEM_OPENED` event is NOT required for trailing missions:
  `reconcileOpenIntent` links bound missions without writing that
  event — the binding row is the authority.

Any violation → `FAIL_CLOSED_ROUTINE_PROVENANCE_CORRUPT` → quarantine
→ no fold, no open, no new binding, no new mission, no WCP.

### 20.2 Seam consumption

- `syncWorkItem` (unbound branch): routine exception only when
  `mission_ids.length === 1` AND `proveCanonicalRoutineLineage`
  succeeds — i.e. last == projected AND the full fire proof. Any
  other shape → quarantine (routine items can never fall into the
  generic unbound path).
- `syncRoutineMirror`: `assertCanonicalRoutineLineage` (catch →
  quarantine) AND `mids.length === 1 && mission_id === mids[0]` —
  foreign tail can never be folded.
- `reconcileWorkLifecycle` (routine DONE branch):
  `mids.length === 1 && proveCanonicalRoutineLineage` before the
  mission-completion proof; otherwise quarantine.
- `promoteRoutineMirror` / `openWorkItem`: the item must already
  carry `blocked_code === null` (quarantined rows fail there) and
  `promoteRoutineMirror` re-runs `assertCanonicalRoutineLineage`
  before WGM validation — a foreign tail hiding a live mission makes
  open fail closed with zero new intent/binding/mission/dispatch.

### 20.3 Project pin closure

`assertCanonicalRoutineFire` now pins scope DIRECTLY:
`mission.project_id === schedule.project_id === business.project_id`
(top-level mission field — not inferred from `metadata.business_id`),
mission `metadata.business_context.business_id === routine.business_id`
(control-plane pinned scope; `metadata.business_id` pin retained from
R1), plus `occurrence.business_id === routine.business_id` — the
canonical occurrence scope field written by `claimOccurrence` from the
schedule's pinned business.

### 20.4 R2 tests — `P14-FC-R2-*` (9)

`-APPENDED-FOREIGN-TERMINAL-MISSION-FAILS-LINEAGE`,
`-FOREIGN-LAST-MISSION-CANNOT-DRIVE-MIRROR-STATE`,
`-FOREIGN-TERMINAL-CANNOT-BYPASS-ACTIVE-MISSION-GATE`,
`-FOREIGN-COMPLETED-MISSION-CANNOT-PROJECT-DONE`,
`-TRAILING-UNBOUND-MISSION-AFTER-PROMOTION-FAILS`,
`-CANONICAL-BOUND-TRAILING-MISSION-PASSES`,
`-MULTIPLE-CANONICAL-REOPENS-PRESERVE-LINEAGE`,
`-MISSION-PROJECT-MISMATCH-FAILS`,
`-OCCURRENCE-BUSINESS-SCOPE-MISMATCH-FAILS`.

### 20.5 R2 E2E additions (Golden FC E2E now 60/60)

Occurrence 3 fired + bound → live RUNNING scheduler mirror → foreign
FAILED mission id appended via direct store write → RESTART → board
quarantines (`TERMINAL_PROVENANCE_CORRUPT`, mids preserved at 2, no
foreign fold) → `openWorkItem` → **409, Δmissions=0, bindings=0,
pending_open_id=null, no WCP** → separately: occurrence 4 → FAILED →
BLOCKED mirror → legitimate canonical reopen still succeeds (promote
→ WGM + bound mission → WCP → DONE). Store `verifyIntegrity` = 0
errors as a final audit check.

### 20.6 R2 regression / platform matrix

- Focused: P14-P3 suite **97/97** (R1 15 + R2 9 + prior preserved).
- Regression: P3 97 · P2 55 · Phase1 73 · P14F 35 · RH 11 · P13 67 ·
  P12 71 · P11+r 103 · P10 31 · P9 79 · P6 36 = **658/658**.
- **Node22: 2194 pass + 2 fail** — the same two pre-existing P5 env-gap
  failures (executor probes expecting absent DSH/CODEX binaries;
  unchanged, unrelated to this diff).
- **Node20: 2196/0**. tsc clean · `pnpm build` PASS ·
  `pnpm audit` 0 high (1 low + 8 moderate transitive, pre-existing).

### 20.7 R2 convergence reassessment

Closed by strengthening the existing routine provenance validator and
consuming it at the existing seams — no second runtime/planner/router/
completion authority and no routine execution authority introduced.
Convergence declaration stands.

## 21. R2 classification

**`P14_WORKFORCE_V2_FINAL_CLOSURE_R2_PENDING_INDEPENDENT_AUDIT`**
