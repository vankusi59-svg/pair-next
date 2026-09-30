# PAIR OS VNext — P14 WORKFORCE V2 PHASE 1 REPORT

**Classification at push:** `P14_WORKFORCE_V2_PHASE1_PENDING_AUDIT`
**Base (canonical main):** `ef1fb11b214d7917b6d827efb223ddc22ae19511`
**Head:** `cf871040120e54721a6d1ab6586492a3bc3fa9d1`
**Branch:** `devin/1790731419-p14-workforce-v2-p1`
**Scope:** governed work graph + parent→child decomposition + dependency DAG + delegation core + child missions through the merged Foundation V2 path. Phase 1 only — no heartbeat, inbox, autonomous reassignment, scheduling, parent completion cascade, CEO loop, P15/P16.

---

## 1. Architecture

`WorkforceService` (`src/pair/work-graph.ts`) coordinates; it never executes. Single canonical chain unchanged:

```
WorkItem → BusinessLayer.openWorkItem → work_open_binding → bound mission
→ Planner → MissionRouter → GovernedTaskGate → executors → MissionRuntime
```

No second router, dispatcher, runtime, planner authority, recovery engine, or permission system. Children open missions ONLY via `openWorkItem` (the Foundation V2 seam): binding pins `mission_id` before creation, `createBoundMission` remains the sole `bound_open_id` mint, ADMISSION vs PROVENANCE semantics unchanged.

## 2. Graph authority model

Following the Foundation V2 rule — **caller metadata can never create graph authority**. Graph membership is proven only by canonical durable rows written inside ONE `store.immediate()` transaction:

| Entity | Id | Proves |
|---|---|---|
| `work_graph_edge` | `WGE_<digest(dep,dep)>` | dependent → dependency (ACTIVE/REVOKED — append-only, revoked in place) |
| `work_delegation` | `WDEL_<child>` | delegation_key, parent, from→to agent, depth, business, project |
| `work_decomposition` | `WDEC_<parent>` | committed decomposition_id + child_work_item_ids |

`work_item` rows mirror graph fields (`parent_work_item_id`, `delegated_*`, `delegation_key`, `delegation_depth`, `decomposition_id`, `decomposed_as`) as observability. `BusinessLayer.assertGraphAuthority(row)` — called at `openWorkItem` and by `reconcileWorkGraph()` on boot — requires every claimed membership to have a matching COMMITTED canonical row:

- `delegated_*` ⇒ `WDEL_<child>` matching parent/from/to/key/business;
- `decomposition_id` ⇒ `WDEC_<parent>` listing the child (child marker — "created me");
- `decomposed_as` ⇒ `WDEC_<self>` matching (parent marker — "I decomposed as");
- bare `parent_work_item_id` ⇒ forged.

Violations quarantine via the existing `TERMINAL_PROVENANCE_CORRUPT` mechanism and throw `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT` — a forged row never reaches binding/mission creation.

Note: `decomposed_as` (parent marker) is deliberately distinct from `decomposition_id` (child marker) — a decomposed child that is itself decomposed keeps both provenances valid.

## 3. Decomposition

`decomposeWorkItem(parent, {decomposition_id, children[]})` — one `immediate()`:

1. Parent exists, not quarantined, graph-authority-clean, non-terminal.
2. `WDEC_<parent>` exists + same `decomposition_id` → idempotent replay (returns committed children, zero new rows). Different id → `FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT`.
3. Proposal validated BEFORE any write: dep indices in range + earlier-siblings-only (acyclic by construction); assignees ACTIVE same-business; inherited `required_capability` satisfied (agent declared caps ∩ contract allow ∩ ¬deny).
4. Children minted via deterministic ids `DC_<digest(parent|decomp|i)>` — v0-INSERT makes concurrent duplicates exactly-once; children inherit business/project/required_capability from the parent row only.
5. Sibling dependency edges materialize in the SAME transaction.
6. `WDEC` row COMMITTED + `parent.decomposed_as` + `WORK_DECOMPOSED` event — all-or-nothing; a crash mid-txn leaves zero partial state (verified by test: validation fault after child-0 spec leaves no children, no WDEC, no edges).

## 4. Delegation

`delegateWorkItem({parent, from, to, reason?, delegation_key?})` — one `immediate()`:

- parent not quarantined/authority-clean/non-terminal; `by`+`to` exist, same business, both **ACTIVE** (new delegation = admission semantics); no self-delegation; depth cap 8, node cap 256/business.
- `required_capability` narrowing: `to` must satisfy the parent's capability (declared `capabilities` + contract `allowed ∩ ¬denied`) — delegation narrows, never expands.
- deterministic child `DL_<digest(parent|key)>`; an existing child must match FULL provenance (business, parent, delegated_from/by, assignee=to, depth, key, reqcap) or `FAIL_CLOSED_WORK_DELEGATE_CONFLICT`.
- child + `WDEL` row + `WORK_DELEGATED` event commit atomically. Same key replay is idempotent; concurrent duplicates lose v0-CAS.
- Delegation PROOF is bidirectional: row fields must match the WDEL row — a forged `assignee_agent_id`, forged delegation fields, or a forged WDEL row with mismatched key never proves (quarantine).

## 5. Dependency gating

`setWorkItemDependencies(id, deps, expected_version, actor)` — one `immediate()`: node non-terminal + quarantine-free; every dep exists, same business, same project (same business ⇒ same project); no self-edge; transitive cycle check; input deduped (duplicate edge = deterministic idempotent); caller `expected_version` CAS required (`FAIL_CLOSED_VERSION_CONFLICT`); old edges REVOKED in place (audit preserved), new `WGE_*` rows ACTIVE; `WORK_DEPENDENCIES_SET` event.

Gate: `openWorkItem` calls `assertDependenciesSatisfied` — every ACTIVE dependency must be **proven DONE**: `proveWorkItemDone` (bound COMPLETED mission + review acceptance when `requires_review`) and not quarantined. A status-flipped DONE without mission evidence → `FAIL_CLOSED_WORK_DEPENDENCY_UNMET`. Verified live: dependent child refused `/open` until the prerequisite's bound mission completed and folded DONE.

## 6. Restart / concurrency properties

- All mutations serialize through `store.immediate()` (BEGIN IMMEDIATE) — no partial authoritative state.
- Deterministic ids (DC_/DL_/WGE_/WDEC_/WDEL_) + v0-CAS create = exactly-once across retries/restarts/processes.
- `reconcileWorkGraph()` runs at server boot (and is callable): forged or incompletely-materialized graph fields quarantine; already-quarantined rows are not re-reported. Restart can never fabricate missing graph evidence.
- Repeated restart is idempotent (verified: reopen stack → same children/edges, replay returns identical ids, reconcile clean).
- No recovery path widens capability/permissions.

## 7. API surface (operator-gated, same auth model)

- `POST /api/work-items/:id/decompose` `{decomposition_id, children[]}`
- `POST /api/work-items/:id/delegate` `{delegated_by_agent_id, delegated_to_agent_id, reason?, delegation_key?}`
- `PUT /api/work-items/:id/dependencies` `{depends_on:[], expected_version}`
- `GET /api/businesses/:id/work-graph` → nodes (+`dependencies_satisfied`) / edges / delegations / decompositions

`scripts/serve-mission-control.mjs` constructs `WorkforceService` and runs `reconcileWorkGraph()` at boot (logs `WORK_GRAPH: quarantined N` only when forged rows found).

## 8. Selective reuse from closed PR #8

Inspected `devin/1790682872-p14-autonomous-workforce` (reference only, never merged). Ported, re-validated against Foundation V2:

- deterministic child ids `DL_/DC_` via digest — kept, re-keyed on canonical fields;
- single-transaction delegation with full-provenance replay + delegation audit;
- one-transaction decomposition claim+materialize+bind;
- graph bounds (depth 8 / node 256 / child 16).

NOT ported: depends_on-as-row-field edges (replaced by canonical `work_graph_edge` rows for durable per-edge provenance), WORK_DELEGATED-as-proof (replaced by `work_delegation` row + bidirectional field check), heartbeat/inbox/auto-assign/review graph (Phase 2+), quarantine-parent-on-delegate (kept — it was ported), heartbeat machinery.

## 9. Tests — 15 focused (`src/__tests__/pair-p14-workforce-v2.test.ts`)

| Test | Result |
|---|---|
| GRAPH-HAPPY (canonical edges + projection) | PASS |
| GRAPH-CYCLE (self + transitive) | PASS |
| GRAPH-CROSS-BUSINESS | PASS |
| GRAPH-CROSS-PROJECT / missing-node / stale CAS | PASS |
| DECOMPOSE-RACE (idempotent replay + conflict) | PASS |
| DECOMPOSE-CRASH (zero partial state + forged quarantine) | PASS |
| DELEGATE-HAPPY | PASS |
| DELEGATE-INACTIVE-AGENT | PASS |
| DELEGATE-WRONG-BUSINESS | PASS |
| DELEGATE-CAPABILITY-WIDEN | PASS |
| DELEGATE-RACE (same key exactly-once) | PASS |
| FORGED-DELEGATION (fields-only + mismatched WDEL) | PASS |
| FORGED-DONE-DEPENDENCY (status w/o mission proof) | PASS |
| CHILD-BOUND-MISSION (bound_open_id + BOUND binding) | PASS |
| RESTART-IDEMPOTENT | PASS |

## 10. Validation matrix

| Suite | Result |
|---|---|
| Focused WFV2-P1 | 15/15 |
| P14 Foundation V2 | 35/35 |
| Runtime hardening | 11/11 |
| P13 | 67/67 |
| P12 | 71/71 |
| P11 (+R1..R6) | 103/103 |
| P10 | 31/31 |
| P9 | 79/79 |
| P6 | 36/36 |
| Node 22 full | 1984 pass + 2 fail (P5 DSH/CODEX env-gap, pre-existing) |
| Node 20 full | 1986 pass / 0 fail |
| typecheck | clean |
| build | PASS |
| `pnpm audit --audit-level=high` | 0 high / 0 critical (8 moderate + 1 low below threshold) |
| verifyIntegrity | clean on fresh-server db (98 entities / 131 events incl. graph rows) |

## 11. Fresh-server E2E (mandate §11)

Killed all PAIR processes → head `cf87104` → rebuilt → fresh server `PAIR_MC_DIR=/home/ubuntu/pair-mc-wfv2` (Node 22, DSH+CODEX env):

1. business + 3 agents (caps `FILE_OPERATIONS`) + parent `WI_*`;
2. `POST .../delegate` → `DL_*` child, `WDEL` row COMMITTED, `WORK_DELEGATED` event;
3. `POST .../decompose` `DEC-E2E` → `DC_*` ×2, sibling edge `DC_8d9a→DC_d81d` ACTIVE, parent `decomposed_as=DEC-E2E`;
4. `POST .../open` on dependent `DC_8d9a` → **409 `FAIL_CLOSED_WORK_DEPENDENCY_UNMET`**;
5. open `DC_d81d` → `IN_PROGRESS`, bound mission `MSN_*` (`bound_open_id` set, binding BOUND);
6. mission → COMPLETED → board read folds `DC_d81d` → DONE;
7. re-open `DC_8d9a` → **IN_PROGRESS, its own bound mission** — dependency unlocked only by proven DONE;
8. pause `workerB` → delegate → **409 `FAIL_CLOSED_AGENT_INACTIVE`** (zero residue);
9. replay `decompose DEC-E2E` with different children → returns committed children (idempotent, zero new rows);
10. kill + restart on same pair.db → `reconcileWorkGraph` clean (no `WORK_GRAPH:` quarantine log), graph intact: 4 nodes / 1 edge / 1 delegation / 1 decomposition.

## 12. Changed files

- `src/pair/work-graph.ts` (new) — WorkforceService, entities, validators
- `src/pair/business.ts` — org_agent `capabilities`; internal graph fields on work_item; `assertGraphAuthority` / `assertDependenciesSatisfied` / `dependencyEdgesOf` / `hasGraphFields`; open-seam gates; `TERMINAL_WORK_ITEM_STATUSES` export; `decomposed_as` marker field
- `src/pair/mission-control-server.ts` — workforce dep + 4 endpoints
- `src/pair/index.ts` — export
- `scripts/serve-mission-control.mjs` — wiring + boot reconcile
- `src/__tests__/pair-p14-workforce-v2.test.ts` (new)
- `PAIR_OS_VNEXT_P14_WORKFORCE_V2_PHASE1_REPORT.md`, `CURRENT_STATE.md`

## 13. Remaining Phase 2+ work (explicitly out of scope)

- heartbeat / agent inbox / collaboration, autonomous reassignment
- parent completion cascade (children-DONE → parent progression)
- edge-revocation governance beyond setDeps (e.g. dep-cancel policy)
- workforce scheduling / capacity, CEO loop, P15, P16
- UI surface for the work graph
