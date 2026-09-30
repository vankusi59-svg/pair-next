# PAIR OS VNext — P14 WORKFORCE V2 PHASE 1 REPORT

**Classification at push:** `P14_WORKFORCE_V2_PHASE1_REMEDIATED_R2_PENDING_AUDIT`
**Base (canonical main):** `ef1fb11b214d7917b6d827efb223ddc22ae19511`
**Head (R2):** `5aeaeb50fb529ca35cc1060bc411cc41b6f3845c` (R1: `ce1c9ea94518face627e7370f54e7bedfacb3083`; Phase 1 original: `cf871040120e54721a6d1ab6586492a3bc3fa9d1`)
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

## 9. R1 remediation — canonical graph provenance + collision + authority narrowing

Independent-audit mandate (five defects). All closed in this section.

### 9.1 Central canonical validators (`src/pair/graph-authority.ts`, new)

Three validators prove the **full chain** per entity — not field subsets —
and throw `IntegrityError("FAIL_CLOSED_WORK_GRAPH_ROW")` on any break.
`BusinessLayer.assertGraphAuthority` wraps every call: a malformed
canonical row quarantines the affected work_item
(`FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`) and can never become executable.

- `assertCanonicalEdge(row)` — `edge_id === WGE_<digest(dep,dep)>`
  recomputed from endpoints; both nodes exist; no self-edge; same
  business; stored `business_id`/`project_id` equal the canonical
  relationship's; `state ∈ {ACTIVE, REVOKED}`. `writeEdge` validates an
  existing deterministic row before adopting/reviving it — a payload-
  mismatched row is never silently reused.
- `assertCanonicalDelegation(row)` — `delegation_id === WDEL_<child>`;
  child + parent resolve; same business; stored project equals canonical
  business project; mode-consistent provenance (`AGENT` ⇒
  `delegated_from_agent_id === child.delegated_by_agent_id ===
  parent.assignee_agent_id`; `OPERATOR` ⇒ from/by null +
  `delegated_by_operator` present); back-references on the child
  (delegated_from/by/key/assignee=to); `depth ===
  child.delegation_depth === parent.delegation_depth + 1`; child
  `required_capability === parent`'s; child `decomposition_id === null`;
  COMMITTED.
- `assertCanonicalDecomposition(row)` — `decomposition_id ===
  WDEC_<parent>` and `parent.decomposed_as === decomposition_id`;
  business/project canonical; COMMITTED; persisted proposal recomputes
  to stored `proposal_digest`; child list order equals the proposal;
  every child resolves and proves back-references (parent,
  decomposition_id, business) + spec match (title/goal/assignee/
  requires_review/required_capability) + no delegation provenance +
  ACTIVE edges equal `spec.depends_on`.

### 9.2 Proposal digest — replay identity is payload identity

`proposal_digest = digest({schema, parent_work_item_id,
decomposition_id, business_id, children: ResolvedChildSpec[]})` where
each resolved spec carries work_item_id/title/goal/assignee/
requires_review/required_capability/depends_on (resolved child ids —
dep topology included). Persisted with `proposal` on the WDEC row.
Rules: same decomposition_id + same digest → idempotent replay through
`assertCanonicalDecomposition`; same id + different digest →
`FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT`. Digest check runs inside the
same `immediate()` txn — race-safe under CAS.

### 9.3 Collision adoption — provenance before adoption

A pre-existing deterministic `DC_*` row is adopted ONLY when it is
provably this decomposition's own un-committed residue: exactly one
store write (version 1 — created, never mutated), full spec/business/
parent/decomposition_id match, no delegation provenance, fresh status
(`READY` iff assignee else `BACKLOG`), `mission_ids` empty,
`blocked_code` null, `source === "decomposition"`. Anything else →
`FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT`. A mismatched child is never
repaired or adopted.

### 9.4 Delegator identity is canonical (R1 §5)

`delegateWorkItem` splits into `delegation_mode` AGENT | OPERATOR
(recorded on WDEL + enforced by the validator):

- **AGENT**: `delegated_by_agent_id` MUST equal the parent's canonical
  `assignee_agent_id`; any other agent — even ACTIVE same-business —
  fails `FAIL_CLOSED_WORK_DELEGATE_AUTHORITY`. No ceiling ⇒ no AGENT
  mode.
- **OPERATOR**: operator-directed delegation; `delegated_by_agent_id`
  omitted; provenance recorded as `delegated_by_operator`.

### 9.5 Authority narrowing — child ⊆ parent ceiling (R1 §6)

`effectiveAuthority(agentId)` resolves the agent's CURRENT P12 contract
into concrete sets — capabilities (registered ∩ allowed − denied),
executors/routes (catalog ∩ allow ∩ hard-restrict − denied), projects,
context scopes. `assertAuthoritySubset(child, parent)` throws
`FAIL_CLOSED_WORK_AUTHORITY_WIDEN` on any dimension where the child set
is not ⊆ the parent's. Enforced at delegation (when the parent has an
assignee ceiling) and at decomposition (directly-assigned children
while the parent has a ceiling). Explicit parent denies remain denied
automatically via effective sets. Unassigned parent → no fabricated
ceiling: the explicit operator/decomposition admission rule applies
(ACTIVE same-business + required-capability check), business/project
scope stays canonical. No second permission system — this consumes the
same P12 contract semantics.

### 9.6 Server fix

`mission-control-server.ts` only read request bodies for POST — the
`PUT /api/work-items/:id/dependencies` endpoint always received `{}`
(always `expected_version=-1`, `depends_on=[]`) and was unusable. Bodies
now parse for PUT too.

## 10. Tests — 24 focused (`src/__tests__/pair-p14-workforce-v2.test.ts`)

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
| RESTART-IDEMPOTENT (replays identical spec per R1 digest rule) | PASS |
| R1-DECOMP-SAME-ID-DIFFERENT-PAYLOAD (same id, changed spec → conflict) | PASS |
| R1-DECOMP-PREEXISTING-CHILD-COLLISION (forged residue never adopted; exact-match residue proves) | PASS |
| R1-WDEC-PAYLOAD-MISMATCH (malformed canonical row quarantines) | PASS |
| R1-WDEL-WRONG-CHILD-ID / WRONG-PROJECT / WRONG-DEPTH (each fails canonical proof) | PASS |
| R1-WGE-PAYLOAD-MISMATCH (malformed edge never revived; quarantine) | PASS |
| R1-DELEGATOR-NOT-PARENT-ASSIGNEE (arbitrary ACTIVE agent → FAIL_CLOSED_WORK_DELEGATE_AUTHORITY) | PASS |
| R1-DELEGATE-AUTHORITY-WIDEN (broader delegatee contract fails closed) | PASS |
| R1-DECOMPOSE-AUTHORITY-WIDEN (assigned child exceeding parent ceiling fails) | PASS |
| R1-HAPPY (valid delegation still opens child via Foundation V2) | PASS |

## 11. Validation matrix

| Suite | Result |
|---|---|
| Focused WFV2-P1 (+R1) | 24/24 |
| P14 Foundation V2 | 35/35 |
| Runtime hardening | 11/11 |
| P13 | 67/67 |
| P12 | 71/71 |
| P11 (+R1..R6) | 103/103 |
| P10 | 31/31 |
| P9 | 79/79 |
| P6 | 36/36 |
| Node 22 full | 1993 pass + 2 fail (P5 DSH/CODEX env-gap, pre-existing) |
| Node 20 full | 1995 pass / 0 fail |
| typecheck | clean |
| build | PASS |
| `pnpm audit --audit-level=high` | 0 high / 0 critical (8 moderate + 1 low below threshold) |
| verifyIntegrity | clean on populated graph db (12 entities incl. WDEC/WDEL/WGE) |

## 12. Fresh-server E2E (mandate §9)

Killed all PAIR processes → branch head → rebuilt → fresh server
`PAIR_MC_DIR=/home/ubuntu/pair-mc-r1` (Node 22):

1. business + 2 agents + parent assigned to `A`;
2. `POST .../delegate` with `delegated_by_agent_id = B` (≠ assignee) → **409 `FAIL_CLOSED_WORK_DELEGATE_AUTHORITY`** — arbitrary ACTIVE agent cannot claim delegation;
3. `delegated_by = A` → `DL_*` child; WDEL row carries `delegation_mode: "AGENT"`, `delegated_from_agent_id = A`, `delegated_by_operator: null`;
4. `decompose DEC1` → `DC_*` child; WDEC carries `proposal_digest`;
5. replay `DEC1` with a DIFFERENT spec → **409 `FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT`** (same-spec replay is idempotent);
6. `PUT .../dependencies` (PUT body fix verified live) → sibling edge ACTIVE;
7. forged `project_id` on the WGE row (direct sqlite edit) → `POST .../open` on the dependent → **409 `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`**; dependent durably quarantined (`blocked_code = TERMINAL_PROVENANCE_CORRUPT`); forged edge never revived.

## 13. Changed files (R1)

- `src/pair/graph-authority.ts` (**new**) — central canonical validators + digest/proposal helpers
- `src/pair/work-graph.ts` — digest identity, collision adoption, delegation modes, authority narrowing, validated edge reuse; re-exports validators
- `src/pair/business.ts` — `assertGraphAuthority` consumes full validators (+ edge-chain loop, independent decomposed_as/decomposition_id checks)
- `src/pair/mission-control-server.ts` — PUT body parsing fix
- `src/__tests__/pair-p14-workforce-v2.test.ts` — 9 R1 adversarial tests
- `PAIR_OS_VNEXT_P14_WORKFORCE_V2_PHASE1_REPORT.md`, `CURRENT_STATE.md`

(Phase 1 original file list below.)

## 14. Phase 1 original tests — preserved (all 15 re-run green under R1)

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
| RESTART-IDEMPOTENT (replays identical spec per R1 digest rule) | PASS |

### Phase 1 original file list

- `src/pair/work-graph.ts` (new) — WorkforceService, entities, validators
- `src/pair/business.ts` — org_agent `capabilities`; internal graph fields on work_item; `assertGraphAuthority` / `assertDependenciesSatisfied` / `dependencyEdgesOf` / `hasGraphFields`; open-seam gates; `TERMINAL_WORK_ITEM_STATUSES` export; `decomposed_as` marker field
- `src/pair/mission-control-server.ts` — workforce dep + 4 endpoints
- `src/pair/index.ts` — export
- `scripts/serve-mission-control.mjs` — wiring + boot reconcile
- `src/__tests__/pair-p14-workforce-v2.test.ts` (new)
- `PAIR_OS_VNEXT_P14_WORKFORCE_V2_PHASE1_REPORT.md`, `CURRENT_STATE.md`

## 15. Remaining Phase 2+ work (explicitly out of scope)

- heartbeat / agent inbox / collaboration, autonomous reassignment
- parent completion cascade (children-DONE → parent progression)
- edge-revocation governance beyond setDeps (e.g. dep-cancel policy)
- workforce scheduling / capacity, CEO loop, P15, P16
- UI surface for the work graph

---

## 16. R2 — dependency-set authority + persisted authority ceiling (mandate §1–§8)

### 16.1 `work_dependency_set` — the omission-safe dependency manifest (§1)

New canonical entity: `work_dependency_set`, id `WDS_<work_item_id>`:

```
{ dependency_set_id, work_item_id, business_id, project_id,
  active_edge_ids[], dependency_work_item_ids[],
  dependency_set_digest, revision, state: "COMMITTED",
  created_by, created_at, updated_at, version }
```

`dependency_set_digest` = canonical digest over `{schema, work_item_id, sorted(active_edge_ids), sorted(dependency_work_item_ids)}` — tamper-evident.

Written **inside the same `immediate()`** as the edge mutations it records:

- `setWorkItemDependencies()` → after revoke/write of edges, `writeDependencySet()` rewrites the manifest (revision+1);
- `decomposeWorkItem()` → every child gets its manifest in the same txn as its sibling edges;
- `delegateWorkItem()` → the new child starts with a canonical **empty** manifest — `setDependencies([])` semantics: an empty dependency set is a canonical row, never an inferred absence.

`assertCanonicalDependencySet(deps, set)` proves the full chain: key identity (`WDS_<id>`), node resolves, business/project match, COMMITTED, integer revision ≥ 1, sorted lists, digest recompute; every listed edge resolves + passes `assertCanonicalEdge` + `dependent_work_item_id === id` + ACTIVE; the resolved dep set equals `dependency_work_item_ids`; and **no ACTIVE edge for that dependent may exist outside the manifest**.

### 16.2 Manifest consumption (§2)

- `assertGraphAuthority(row)` — validates all edge rows for the dependent (a malformed REVOKED edge still quarantines), then the manifest: present → `assertCanonicalDependencySet`; absent → corrupt iff any edge claims the dependent or the row is a governed child (`delegated_from_work_item_id` / `decomposition_id`). *"No WGE rows" never means "no deps".*
- `assertDependenciesSatisfied(row)` — the set to satisfy comes from `manifest.dependency_work_item_ids` after revalidation; missing manifest + edge claims or governed-child status → `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT` (quarantine).
- Adversarial coverage: dep edge mutated to another dependent → original dependent's manifest still lists the edge but the edge no longer claims it → closed; and the new dependent sees an extra unlisted ACTIVE edge → closed. Both directions quarantine.

### 16.3 Persisted authority ceiling (§3)

`authorityCeilingSnapshot(agentId)` = normalized sorted arrays `{agent_id, capabilities[], executors[], routes[], projects[]|null, context_scopes[]}` + `authorityCeilingDigest` over the snapshot — computed from the P12 contract **at the moment of the graph mutation**:

- **AGENT delegation** → WDEL row carries `authority_ceiling_agent` (= delegator), `authority_ceiling`, `authority_ceiling_digest`. OPERATOR delegation on an *assigned* parent carries the parent assignee's ceiling (the authority source, not the delegator); on an unassigned parent all three fields are explicit nulls — no fabricated ceiling.
- **Decomposition** → the committed proposal gains `authority_ceiling_agent` + `authority_ceiling`; `proposal_digest` covers them. Validators enforce self-consistency (ceiling.agent_id === ceiling_agent; digest recompute matches; AGENT ⇒ ceiling_agent === delegated_from).

### 16.4 Open-time subset enforcement (§4)

`assertChildAuthorityCeiling(row)` runs inside `openWorkItem` after dep gating, **before any binding/mission**:

```
effective child ceiling = persisted snapshot (WDEL ceiling / WDEC proposal ceiling)
                        ∩ CURRENT parent ceiling agent's authority
                        ∩ child's CURRENT authority  (⊆ checks)
                        ∩ existing PAIR policy (assertExecutable + binding pin)
```

- Widening the child's contract after commit → `FAIL_CLOSED_WORK_AUTHORITY_WIDEN` (child exceeds persisted ceiling).
- Narrowing the parent's contract later → child fails at open vs current parent authority (later revocations narrow, never broaden).
- Parent broadening later can never expand the stored child ceiling — the snapshot is the cap.
- Explicit denies remain denies (deny-free sets cannot reintroduce a denied id).

### 16.5 DISABLED contract admission (§5)

`effectiveAuthority` returns empty sets for a non-ACTIVE contract, and new admission now proves current executability directly: `delegateWorkItem` / `decomposeWorkItem` call `assertExecutable` (agent ACTIVE, contract ACTIVE + integrity, business/project scope) → `FAIL_CLOSED_AGENT_CONTRACT_DISABLED` at admission. `assertChildAuthorityCeiling` re-checks it at open. Provenance rows stay historically valid; admission uses the live contract.

### 16.6 Immutable decomposition topology (§6)

`setWorkItemDependencies` on a row whose `decomposition_id` is canonically proven → `FAIL_CLOSED_WORK_DECOMPOSITION_TOPOLOGY_IMMUTABLE` **before** the version check and any write — no partial revocation, no quarantine generated by the rejected operation. Delegated/non-decomposition items keep the mutable path; every mutation refreshes the manifest atomically.

### 16.7 Reconcile (§8)

`reconcileWorkGraph` additionally: validates every `work_dependency_set` row (malformed → quarantine its work item); quarantines governed children lacking a manifest; quarantines any dependent with edge rows but no manifest; and — via the full WDEC/WDEL validators — persisted authority-ceiling digests. Nothing is silently rebuilt from mutable live fields; restart never fabricates a lost dependency or ceiling.

### 16.8 R2 tests — 11 focused (35 total in suite)

| Test | Covers |
|---|---|
| WFV2-P1-R2-WGE-MOVED-DEPENDENT | moved edge fails both dependents |
| WFV2-P1-R2-WGE-MISSING-EXPECTED | manifest-listed edge revoked → closed |
| WFV2-P1-R2-WGE-EXTRA-ACTIVE | unlisted ACTIVE edge → closed |
| WFV2-P1-R2-EMPTY-DEPENDENCY-MANIFEST | canonical empty set (rev 2, digest, open clean) |
| WFV2-P1-R2-DELEGATE-CONTRACT-WIDEN-AFTER-COMMIT | widened delegatee → open WIDEN, zero missions |
| WFV2-P1-R2-PARENT-NARROW-AFTER-COMMIT | current parent narrowing applies at open |
| WFV2-P1-R2-DECOMPOSE-CONTRACT-WIDEN-AFTER-COMMIT | widened decompose assignee → open WIDEN |
| WFV2-P1-R2-DISABLED-CONTRACT-ADMISSION | disabled → delegate/decompose/open all closed |
| WFV2-P1-R2-DECOMP-DEP-MUTATION-REJECTED | IMMUTABLE + no quarantine + no partial writes |
| WFV2-P1-R2-DELEGATED-DEP-MUTATION-HAPPY | delegated child mutable, manifest rev bumps |
| WFV2-P1-R2-RESTART | manifests/ceilings survive; tampered manifest quarantines |

### 16.9 Changed files (R2)

- `src/pair/graph-authority.ts` — WDS row id + digest + `assertCanonicalDependencySet`; `AuthorityCeiling` + snapshot/digest/`authorityToCeilingSet`; `effectiveAuthority`/`assertAuthoritySubset` moved here (shared); `assertCanonicalDelegation`/`assertCanonicalDecomposition` extended for ceiling fields + child manifests
- `src/pair/work-graph.ts` — `writeDependencySet`, manifest writes in all three mutation seams, ceiling snapshot on WDEL/proposal, `assertExecutable` admission checks, immutable-topology rejection, reconcile manifest scans, manifest-driven `dependenciesProven`
- `src/pair/business.ts` — `graphAuthorityDeps` (store + getBusiness + agentContracts), manifest consumption in `assertGraphAuthority`/`assertDependenciesSatisfied`, `assertChildAuthorityCeiling` at open
- `src/__tests__/pair-p14-workforce-v2.test.ts` — +11 R2 tests

### 16.10 Validation (R2 head)

- Focused: **35/35** (15 Phase-1 + 9 R1 + 11 R2)
- P14F 35 · RH 11 · P13 67 · P12 71 · P11 103 · P10 31 · P9 79 · P6 36 — all green
- **Node 22 full: 2004 pass + 2 fail** — same pre-existing P5 env-gap as R1 (executables present where tests expect absent)
- **Node 20 full: 2006/0**
- `tsc --noEmit` clean · `pnpm build` PASS · `pnpm audit --audit-level=high`: 0 high / 0 critical
- `verifyIntegrity` clean on a populated db (graph rows incl. WDS/WDEL/WDEC ceiling fields)
- CI skipped per project policy (not enabled for this branch).

### 16.11 Fresh-server E2E (§10)

Head `5aeaeb50fb529ca35cc1060bc411cc41b6f3845c`; `PAIR_MC_DIR=/home/ubuntu/pair-mc-r2`; killed all prior PAIR processes, rebuilt, fresh server:

1. decompose → children + manifests: `WDS_<c2>` lists the sibling edge, `WDS_<c1>` canonical **empty**;
2. `PUT .../dependencies` on WDEC child → **409 `FAIL_CLOSED_WORK_DECOMPOSITION_TOPOLOGY_IMMUTABLE`**;
3. delegate (assigned parent) → WDEL carries `authority_ceiling_agent` + snapshot + digest;
4. widen delegatee contract → `POST .../open` → **409 `FAIL_CLOSED_WORK_AUTHORITY_WIDEN`** (fails before binding — checked before the mission-active guard);
5. forge: move a dep edge's `dependent_work_item_id` (re-hashed canonically) → open original dependent → **409 `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`** (`dependency-set manifest invalid`) + durable `TERMINAL_PROVENANCE_CORRUPT`; open the edge's new dependent → **409 PROVENANCE_CORRUPT** (`extra edge` not in its manifest);
6. disable delegatee contract → `open` → **409 `FAIL_CLOSED_AGENT_CONTRACT_DISABLED`**;
7. restart → boot reconcile reports `quarantined 2 forged node(s)` (the forged-edge parent + sibling decomposition unit quarantined atomically; plain items untouched).
