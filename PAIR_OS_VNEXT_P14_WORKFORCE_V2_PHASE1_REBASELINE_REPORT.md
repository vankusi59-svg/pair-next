# PAIR OS VNext — P14 WORKFORCE V2 PHASE 1 REBASELINE REPORT

**Classification at push:** `P14_WORKFORCE_V2_PHASE1_REBASELINED_PENDING_AUDIT`
**Base (canonical main):** `ef1fb11b214d7917b6d827efb223ddc22ae19511`
**Branch:** `devin/1790741859-p14-wfv2-p1-rebaseline`
**Scope:** canonical Work Graph, parent→child decomposition, dependency
DAG, governed delegation, child mission opening through Foundation V2,
minimal status/proof projection. Phase 1 only — no heartbeat, inbox,
autonomous reassignment, scheduling, parent completion cascade, CEO loop,
P15/P16.

**This branch replaces PR #11.** PR #11 (`devin/1790731419-p14-wfv2-p1`,
head `44f7166`) is REFERENCE ONLY — never merged, never used as a base,
never cherry-picked wholesale. The final independent audit on it found
two structural defects this rebaseline closes:

1. **Systemic inverse-provenance omission** — graph participation was
   provable only work_item → canonical rows (the item's mutable mirror
   fields had to *claim* governance for checks to fire). Deleting the
   mirror fields degraded a governed child to "standalone" — the exact
   forge the model existed to prevent.
2. **Insufficiently anchored historical authority ceiling** — the
   persisted snapshot+digest could be replaced wholesale by a caller who
   recomputed the digest; nothing bound the ceiling to independent,
   provable contract-revision evidence.

---

## 1. Selective reuse from PR #11

Preserved (re-derived, not copied): deterministic child ids
(`DL_`/`DC_<digest>`), decomposition proposal digest + replay/conflict
semantics, `work_dependency_set` (WDS) manifest model, atomic
decomposition/delegation in one `store.immediate()`, graph-bound assignee
immutability (`FAIL_CLOSED_WORK_GRAPH_ASSIGNEE_IMMUTABLE`), ADMISSION vs
PROVENANCE distinction, bound-COMPLETED-mission dependency proof,
open-time ceiling subset semantics, graph bounds (depth ≤ 8, ≤ 256
nodes/business), Foundation V2 opening path (openWorkItem →
work_open_binding → startBoundMission → Planner → Router → Gate →
Runtime — no second router/dispatcher/planner/permission system).

Re-architected: inverse-safe `work_graph_membership` (WGM),
`work_authority_binding` (WAB), `agent_contract_revision` (ACR) —
all-new, described below.

## 2. Bidirectional graph authority — `work_graph_membership` (WGM)

Deterministic row `WGM_<work_item_id>` written **atomically** inside the
same `immediate()` transaction that writes the work item and its
governing canonical rows. Fields: `work_item_id`, `business_id`,
`project_id`, `membership_type`, `parent_work_item_id`,
`delegation_id`, `decomposition_row_id`, `dependency_set_id`,
`authority_binding_id`, `membership_digest`, `state`, `version`.

`membership_type`:
- `STANDALONE` — written by `createWorkItem` in the same txn (every item
  has a membership row from birth — there is no "pre-graph" state).
- `DELEGATED_CHILD` — `delegation_id = WDEL_<self>`; requires the WDEL
  chain + mirror agreement + WDS manifest + WAB binding.
- `DECOMPOSED_CHILD` — `decomposition_row_id = WDEC_<parent>`; requires
  WDEC lists the child + mirror agreement + WDS + WAB (when the spec
  carried an assignee and a non-null ceiling).
- `GRAPH_PARENT` — proven *by canonical child rows only* (committed WDEL
  naming it as parent, WDEC_<self> matching `decomposed_as`, or being
  listed in another WDEC); never by its own claims.

`assertCanonicalMembership` (`src/pair/graph-authority.ts`) proves the
full bidirectional chain: deterministic key → digest → type-dispatched
canonical-row validation (WDEL/WDEC/WDS/WAB re-validated) → mirror-field
agreement (they must *agree* — they are evidence, not authority) →
universal parent facet (`validateParentFacet` runs for every type: a
child can also be a parent). `membership_digest` (schema
`pair.os.vnext.work-graph-membership.v1`) covers id, business, project,
type, and every structural reference.

**Direction 2 (canonical → item):** `assertGraphAuthority` now keys on
membership first. Membership present → full canonical validation.
Membership absent → the item must be *proven* standalone: any graph
mirror marker OR any committed canonical row governing it (WDEL_<id>,
WDEC_<id>, committed WDEL-as-parent, listed-in-WDEC) fails closed as
`FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`. A governed item can **never**
become standalone because its mutable mirror fields were deleted — the
canonical rows still claim it, and the missing membership is itself
corrupt.

## 3. Historically anchored authority ceiling — `work_authority_binding` (WAB) + `agent_contract_revision` (ACR)

**ACR** (`agent-contract.ts`): every successful contract `materialize`
(v1) and `update` (each version bump) writes
`ACR_<contract_id>_<version>` — `{revision_id, contract_id,
org_agent_id, business_id, contract_version, contract_digest, policy,
status, COMMITTED}` — inside the contract's own transaction. The
historical policy of *every* contract version is durable canonical
evidence, not just the live row.

**WAB** (`WAB_<work_item_id>`, written atomically at delegation /
directly-assigned decomposition child): `work_item_id`,
`ceiling_agent_id`, `agent_business_id`, `contract_id`,
`contract_version`, `contract_digest`, normalized `authority_snapshot`,
`authority_snapshot_digest`, `binding_digest` (schema
`pair.os.vnext.work-authority-binding.v1` over all anchors +
snapshot digest), `created_by`, `state`, `version`.

`assertCanonicalAuthorityBinding` re-proves the ceiling end-to-end:

1. deterministic `WAB_<work_item_id>` key + payload digest;
2. item exists, same business;
3. ceiling agent exists, same business;
4. **revision anchor:** `ACR_<contract_id>_<contract_version>` exists,
   org_agent/business/digest match;
5. **journal anchor:** the append-only event log for
   `agent_execution_contract`/`contract_id` contains an event whose
   metadata pins exactly `contract_version` + `contract_digest` — the
   bound revision must appear in immutable history, not just a table row;
6. `authority_snapshot_digest` recomputes over the stored snapshot;
7. **snapshot ⊆ `policyAuthoritySnapshot(ACR.policy)`** — the stored
   snapshot must be derivable from the *anchored revision's* policy
   (allow − deny, hard preferred-sets when `fallback=false`); a caller
   cannot paste a broader snapshot and recompute digests, because the
   digest chain then diverges from the pinned revision's policy;
8. `binding_digest` recompute over all anchors.
9. Cross-chain: `assertCanonicalMembership` requires
   `binding.authority_snapshot` byte-identical to the provenance ceiling
   persisted on the WDEL/WDEC proposal — forging either side diverges.

A caller therefore cannot: swap the snapshot and rehash (fails ⊆ +
diverges from WDEL ceiling), point at a foreign `contract_id` (revision
org_agent mismatch), bump `contract_version` to a nonexistent one (no
ACR row + no journal event), rewind to a real earlier revision (the
pinned snapshot can't be ⊆ the narrower historical policy), or forge
`contract_digest` (ACR + journal both carry the real one).

**Authority semantics (open):** child `assertExecutable` → persisted WAB
validated (anchors + journal + snapshot ⊆ pinned policy) →
`currentCeilingNarrowing` (child current ⊆ persisted snapshot ∩ current
ceiling-agent authority ∩ current child contract ∩ PAIR policy) — widen
after commit fails `FAIL_CLOSED_WORK_AUTHORITY_WIDEN`; narrow after
commit narrows; PAUSED/TERMINATED ceiling agent or DISABLED contract
fails open before binding/mission. Admission (delegation/directly
assigned decomposition): ceiling agent must `assertExecutable` NOW.

## 4. Dependency authority (preserved WDS model)

Every governed child carries `WDS_<work_item_id>` — including an explicit
empty manifest. `assertCanonicalDependencySet` re-proves the complete
ACTIVE edge list + dep node list + digest + scope; scanning WGE rows
alone can never establish "no dependencies".

## 5. Reconcile

`reconcileWorkGraph` validates every canonical row class
(WGE/WDEL/WDEC/WDS/WGM/WAB) then sweeps **all** work items through
`assertGraphAuthority` — items missing membership, items claiming graph
without canonical rows, items whose canonical rows are corrupt — all
quarantine via `TERMINAL_PROVENANCE_CORRUPT`. Never rebuilds from
mutable mirrors; idempotent across restarts. A corrupt canonical row
poisons **both endpoints** (a forged WDEL quarantines the claimed child
*and* the named parent — its own membership can no longer prove its
graph participation).

## 6. Tests — `src/__tests__/pair-p14-workforce-v2.test.ts` (55)

All 44 ported Phase1/R1/R2/R3 tests pass, plus the 11 mandated
rebaseline adversarial tests:

| Test | Proves |
|---|---|
| `P14RB-P1-DELEGATED-MARKERS-REMOVED` | mirror wipe on delegated child → open `PROVENANCE_CORRUPT`, quarantined, WDEL/WGM still govern |
| `P14RB-P1-DECOMPOSED-MARKERS-REMOVED` | same for decomposition child |
| `P14RB-P1-WGM-MISSING` | physical WGM delete → canonical rows without membership → `PROVENANCE_CORRUPT` |
| `P14RB-P1-WGM-FORGED-STANDALONE` | forged STANDALONE WGM with recomputed digest → still fails (canonical rows disagree) |
| `P14RB-P1-WORK-ITEM-FORGED-GRAPH` | painted graph markers on a standalone item → `PROVENANCE_CORRUPT` |
| `P14RB-P1-CEILING-SNAPSHOT-TAMPER-REHASH` | broadened snapshot + all digests recomputed → fails (⊄ pinned policy + diverges from WDEL ceiling) |
| `P14RB-P1-CEILING-CONTRACT-ID-FORGE` | foreign contract id + its real digest + rehash → fails (revision binds org_agent) |
| `P14RB-P1-CEILING-CONTRACT-VERSION-FORGE` | nonexistent version (no ACR/journal) AND rewind to real earlier revision (snapshot ⊄ narrower pinned policy) → both fail |
| `P14RB-P1-CEILING-CONTRACT-DIGEST-FORGE` | forged contract_digest + rehash → ACR/journal mismatch |
| `P14RB-P1-PARENT-WIDEN-AFTER-COMMIT` | widened child contract → `AUTHORITY_WIDEN`, zero missions |
| `P14RB-P1-PARENT-NARROW-AFTER-COMMIT` | narrowed ceiling contract → child narrows, open fails, zero bindings |

## 7. Validation

- Focused suite: **55/55**
- P14 Foundation V2: 35 · runtime hardening: 11 · P13: 67 · P12: 71 ·
  P11+r1..r6: 103 · P10: 31 · P9: 79 · P6: 36 — all pass
- **Node 22 full: 2024 pass + 2 fail** — `pair-p5` DSH/CODEX probe tests;
  pre-existing environment gap (executables are now installed on this
  box, so "adapter unavailable when binary missing" assertions see
  `available=true` — unrelated to this change, same as PR #11 state)
- **Node 20 full: 2026 pass / 0 fail** (better-sqlite3 rebuilt per ABI)
- `tsc --noEmit` clean · `pnpm build` PASS · `pnpm audit
  --audit-level=high`: 0 high/critical (1 low + 8 moderate, unchanged)
- `verifyIntegrity` clean on populated db

## 8. Fresh-server E2E (`pair-mc-rb`, :8790, head of this branch)

Real server boot, real HTTP API (`Bearer e2e-token` + `x-operator-id`),
real sqlite:

1. business → two org agents (+contract upserts → ACR v1+v2 rows
   present) → parent work item → `POST /delegate` → child `DL_29eec…`
   with `WGM_=DELEGATED_CHILD` (+`WGM_parent=GRAPH_PARENT`), `WDEL`,
   `WDS` (empty manifest), `WAB` (contract `AEC_2669…` v2, snapshot
   digest `61ae4e25…`) — all canonical rows verified in the live db.
2. `POST /open` → `IN_PROGRESS`, `work_open_binding OPI_01M3R9YNE8…`,
   bound mission `MSN_01M3R9YNE8…` carrying `[BUSINESS|DEPT|AGENT]`
   context — the Foundation V2 path end-to-end.
3. Tamper cases (sophisticated forger — rows rewritten via store.put so
   entity hashes recompute):
   - mirror fields stripped → `409 FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`
   - WGM row physically deleted → `409 FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`
   - WAB `contract_version` tampered → `409 FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`
4. **Restart:** `WORK_GRAPH: quarantined 1 forged node(s)` — the parent
   additionally quarantined (bidirectional poisoning by the stripped
   child's WDEL endpoint); all three tampered children remain
   `TERMINAL_PROVENANCE_CORRUPT`; the legitimately opened child survives
   `IN_PROGRESS` with its bound mission intact.

Classification: **`P14_WORKFORCE_V2_PHASE1_REBASELINED_PENDING_AUDIT`** —
STOP. Not merged. No Phase 2, no P15/P16.
