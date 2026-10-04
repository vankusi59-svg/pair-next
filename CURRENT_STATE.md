# Current state of `main` (post-V1.0.0)

The official release record is `RELEASE.json` (`v1.0.0-pair-next-official-final`)
— frozen historical truth. This file tracks what `main` has added since.

## Since V1.0.0

- **Business Layer v0.5** (`src/pair/business.ts`): `business`, `org_agent`,
  `objective`, `work_item`, `routine`, `budget_policy` entities with scope
  isolation, work-item lifecycle, claims, budgets, routine projection.
  Exposed via `/api/businesses|org-agents|work-items|objectives|routines|budgets`.
- **Live governed stack** (`scripts/serve-mission-control.mjs` +
  `scripts/start-pair-live.sh`): server :8788, executor registry
  (NATIVE/DEVIN/DSH/AUTOMATON), Telegram bridge, React Mission Control UI,
  Cloudflare tunnel for external access.
- **Multi-provider model routes**: `PAIR_DSH_MODEL_ROUTE` →
  `PAIR_DSH_FALLBACK_ROUTE` → `PAIR_DSH_EXTRA_ROUTES` (unbounded), probed in
  order at boot; first qualified route becomes planner model.
- **Verified-experience loop**: executions folded into CANDIDATE→QUALIFIED→
  ACTIVE memory every 15s; routing advisor feeds priors into MissionRouter.
  Advisory only — never bypasses gate/approval.
- **P11 hardening**: legal work-item transition map, `claim_token`-verified
  releases, single-dispatch dedup in `openWorkItem`, budget scope validation,
  broker denial auditing, honest CI (no timeout→PASS), new `pair-p11.test.ts`
  regression suite.

## P12 candidate state (on branch, pending audit)

- **Agent Execution Contract** (`src/pair/agent-contract.ts`, table
  `agent_execution_contract`): exactly one versioned contract per
  `org_agent` — capability allow/deny, executor allow/deny/prefer +
  fallback, provider/model route prefer/deny/restrict, project scope,
  context scopes. Contracts only NARROW existing PAIR authority; explicit
  deny wins; unknown capability fails closed. R1: `fallback=false` +
  non-empty preferred set is a HARD restriction per snapshot (executor
  AND route, pinned ∩ current, deny-minus); unknown policy keys rejected;
  live contract row digest revalidated at every resolution; agent-bound
  mission without a pin fails `PIN_MISSING`. R2: canonical
  `assertAgentExecutionAllowed` re-runs at the final pre-dispatch
  boundary (before every NEW `adapter.dispatch`) — adopted governed
  tasks cannot bypass tightening; already-dispatched executions stay
  historical (EXECUTION_PERSISTED / evidence-reconciled intents return
  untouched); bound route revalidated from the canonical task; pin
  schema/version hardened. R3: adoption/idempotency checked BEFORE
  contract resolution in the router (proven history bypasses current
  contract state); missing-local-row crash reconstructs the canonical
  executor_execution from proven evidence (insert-CAS, reconciled_at —
  never a fabricated dispatch_timestamp); `dispatched=true` without id
  fails `FAIL_CLOSED_DISPATCH_EVIDENCE_INCOMPLETE`. R4: adoption now
  identity-validates intent + execution rows (canonical binding:
  task/mission/executor/plan_revision/correlation/workspace — mismatch
  fails `FAIL_CLOSED_EXECUTION_RECONCILE_IDENTITY_MISMATCH` /
  `FAIL_CLOSED_DISPATCH_INTENT_IDENTITY_MISMATCH`); insert CAS-conflict
  is the ONLY adoptable race — event/evidence failures propagate and
  leave the intent recoverable; reconciliation audit is durable before
  intent promotion and self-repairs after a crash gap (at-least-once).
- **Enforcement**: pin at `MissionControl.startMission` (contract id +
  version + digest in mission metadata), authoritative checks in
  `GovernedTaskGate.create_governed_task`, executor/route filtering in
  `MissionRouter` + `RouteSelector`. `effective = pinned ∩ current ∩ PAIR`
  — tightening revokes in-flight authority; expansion never retro-broadens
  a pinned mission. Denials audited as `AGENT_EXECUTION_DENIED`.
- **Legacy compat**: pre-P12 agents materialize a baseline contract on
  first bound mission (audited `AGENT_EXECUTION_CONTRACT_MATERIALIZED`).
- **API**: `GET|POST /api/org-agents/:id/contract`,
  `POST /api/org-agents/:id/contract/(enable|disable)`,
  `GET /api/org-agents/:id/effective-policy`.
- Classification: **`P12_OFFICIAL_FINAL_PASS`** — independent audit
  passed at runtime head `bced1b2db6726cea695bd32a5e39e128cffd166a`
  (PR #5); validation recorded in
  `PAIR_OS_VNEXT_P12_AGENT_EXECUTION_CONTRACT_REPORT.md` (final
  governance closure): P12 71/71, P11 103/103, N20 1858/0, N22
  1856/2env, typecheck+build PASS, audit 0 high, races PASS, integrity
  clean. Still unmerged per manual-merge governance.

### P13 — cost + secrets governance

- **Cost authority** (`src/pair/cost.ts`, `CostService` in
  `PairControlPlane`): `cost_policy` (business/department/agent/mission
  scope; DAY/WEEK/MONTH/MISSION_LIFETIME period; max_microusd + hard_stop +
  warning_threshold), `cost_profile` (versioned pricing refs to
  route/model/executor; billing modes METERED_API/SUBSCRIPTION/FREE/
  UNMETERED/UNKNOWN; USD integer microusd only), `cost_reservation`
  `CRSV_<governedTaskId>` with lifecycle HELD→COMMITTED→SETTLED|RELEASED.
  Atomic check+reserve inside `store.immediate()` (settled+committed+held
  +requested ≤ hard cap in one txn); reconcile derives only from canonical
  dispatch intent + executor_execution + dispatch_evidence — proven
  dispatches are re-accounted, never redispatched; historical execution is
  never double-charged. Hard policy + unbounded METERED_API or UNKNOWN
  billing → fail closed. `PAIR_COST_HALT`/`costHaltFile` preserved — blocks
  new cost-bearing dispatch only.
- **Secret authority** (`src/pair/secret-policy.ts`): `secret_policy`
  per (business, credential_reference_name) with allow-sets
  (agent/executor/project/route) + purpose; missions pin a snapshot
  (`metadata.secret_grants`) at `startMission` — pinned ∩ current policy
  governs every fetch. `POST /api/broker/fetch` now requires
  `authorizeCredentialFetch` (mission/task/ownership → pin → digest
  provenance → business isolation → ACTIVE + narrowed allow-sets → P12
  `effectiveForMission`) before `broker.release`; denials audited with
  metadata only. Broker token remains transport auth, never authorization.
- **API**: `/api/cost` position adds `monetary` (usage by scope,
  HELD/COMMITTED, settled, billing breakdown, unpriced, halt, warnings);
  `GET|POST /api/cost-policies`, `GET|POST /api/cost-profiles`,
  `GET|POST /api/secret-policies` (+`update`/`revoke`).
- **R1 remediation** (same PR): retry authority — RELEASED re-hold re-runs the
  full current decision (halt→billing→caps) in one txn; HELD → audited
  FAIL_CLOSED_COST_RESERVATION_AMBIGUOUS. Pricing pinned into the
  reservation (profile id+version+digest+rates+source); settlement uses the
  pin only, digest-verified; zero-supplied metered bounds stay unbounded.
  Secret release requires canonical `selected_executor` + ROUTED/RUNNING +
  route binding where scoped, and re-evaluates the full P12 effective
  executor/route narrowing at fetch time. `startMission` enforces
  business/project isolation + org_agent membership. `/api/*/update` splits
  control fields; updates never silently create. `allowed_purpose`
  fail-closed until an enforceable subject exists; allow-set reference
  validation added.
- **R2 remediation** (same PR): crash-gap closed — durable ordering is now
  `executor_execution` → `EXECUTION_PERSISTED` → evidence →
  `markCommitted` LAST; a COMMITTED/SETTLED reservation under
  INTENT_RECORDED with no execution proof fails
  `FAIL_CLOSED_COST_COMMITTED_EXECUTION_UNRESOLVED` instead of
  authorizing a new dispatch. UNKNOWN billing + hard policy →
  `FAIL_CLOSED_COST_UNKNOWN` (soft-policy UNKNOWN stays unpriced).
  METERED_API boundedness now requires positive reserve OR positive fixed
  with no rates — `fixed=0` no longer fake-bounds.
- **R3 remediation** (same PR): `startMission` pins a canonical
  `business_context` from the resolved org_agent (business/department
  must match or fail closed; omitted business_id inherits the agent's);
  CostService consumes the pin. Broker token is no longer a cross-task
  bearer — workers carry `bcap1.<payload>.<hmac>` capabilities minted
  server-side, bound to mission/task/governed_task/executor, verified at
  `/api/broker/fetch` (`x-broker-capability`; master alone → 403).
  `POST /api/cost-policies|cost-profiles` are now create-only
  (`FAIL_CLOSED_COST_POLICY_EXISTS` / `FAIL_CLOSED_COST_PROFILE_EXISTS`);
  CAS `/update` + `expected_version` unchanged.
- **R4 remediation** (same PR): untrusted remote output is sanitized
  before it becomes canonical — `sanitizeUntrustedRemote` redacts
  `bcap1.*` capabilities, the master token and broker-released values in
  `collect_execution_result`/`observe_execution` (audit:
  `REMOTE_RESULT_REDACTED` counts only); `assertSecretFree` now
  hard-fails raw `bcap1.*` in entities/evidence/events. `createCost*`
  are INSERT-only atomics (immediate txn + version-0 CAS →
  `FAIL_CLOSED_COST_*_EXISTS`); supplied `cost_policy_id` is the exact
  create identity.
- **R5 remediation** (same PR): sanitizer protection is now
  restart-durable — `CredentialBroker` registers every installed vault
  credential at construction; `MIN_CREDENTIAL_VALUE_LENGTH=8` enforced
  at `upsert` and `load` (`FAIL_CLOSED_CREDENTIAL_VALUE_TOO_SHORT`), so
  no accepted credential can fall under sanitizer coverage. Restart
  isolation proven with a fresh-worker collect path.
- **R6 remediation** (same PR): rotated/deleted credential values are
  retired inside the same vault as redaction-only material — registered
  at startup alongside active values, never releasable or listed; vault
  `load()` is fail-closed (`FAIL_CLOSED_CREDENTIAL_VAULT_INVALID`) on
  malformed JSON/records instead of silently loading `{}`.
- Classification: **`P13_OFFICIAL_FINAL_PASS`**. PR #6 merged into
  `main` at `916a0b92b2e8e122eb7e4e7e76ae36962add21d1`; independently
  audited R6 head `6e01b061439cba16ae78b775a464713a9152728a`;
  independent audit result `P13_R6_INDEPENDENT_AUDIT_PASS`. Evidence in
  `PAIR_OS_VNEXT_P13_COST_SECRETS_GOVERNANCE_REPORT.md`: P13 67/67,
  P12 71/71, P11 103/103, P9 79/79, N20 1925/0, N22 1923/2env,
  typecheck+build PASS, audit 0 high, worker races PASS, verifyIntegrity
  clean.

### P14 FOUNDATION V2 — canonical work-open provenance (NEW branch, pending audit)

> **PR #8 (`P14_PROVENANCE_REBASELINED_PENDING_AUDIT`) is reference-only:
> not merged and not the base of this work.** The V2 foundation is a
> fresh build from canonical base `a38be24b8bb240570d0cce322766ece1bccceab9`
> on a new branch. It is **not** the full P14 workforce — no work graph,
> delegation, heartbeat, or inbox — and **no P15/P16 work has started.**

- **`work_open_binding`** — durable open-authority row created by
  `BusinessLayer.openWorkItem` **before** mission creation:
  `open_id | work_item_id | business_id | project_id | org_agent_id |
  created_by | mission_id | state INTENT|BOUND|ROLLED_BACK | CAS`.
  The link write + `INTENT→BOUND` flip commit in one `store.immediate()`,
  and rollback (row restore + pending/claim clear + `ROLLED_BACK` +
  audit event) commits atomically in one txn too (R1 §1).
- **Public/internal split**: `POST /api/missions` → `startMission`
  hard-rejects any caller `mission_id` (`FAIL_CLOSED_MISSION_ID_PUBLIC`,
  409); the internal `startBoundMission({binding_open_id})` seam
  (BusinessLayer only) loads the binding, validates the full canonical
  chain, and derives the mission_id FROM it — no arbitrary pin accepted;
  missions it creates carry the non-forgeable `bound_open_id` origin
  proof (R1 §2-3). A foreign occupant at a reserved id fails closed
  (`FAIL_CLOSED_MISSION_ORIGIN_CONFLICT`) — R2 §3 requires the FULL
  canonical validator (`forMission`) to pass before any crash-retry
  adoption, origin string alone is not enough. The seam derives the
  mission's canonical context (business/work/agent/department/source)
  from the binding itself — caller metadata conflicts fail closed
  (`FAIL_CLOSED_BINDING_CONTEXT_MISMATCH`), omissions are filled (R2 §1).
  `bound_open_id` is minted ONLY by `createBoundMission(binding, ...)`
  which derives both ids from the binding — generic `createMission`
  accepts no `mission_id`/`bound_open_id` and always stamps null
  (R2 §2). Version-0 CAS still fails closed on collision
  (`FAIL_CLOSED_MISSION_PIN` guard on the returned id).
  `src/pair/work-open-binding.ts` is the single canonical binding
  validator used by every provenance seam (R1 §5) — R2 §4 adds
  non-empty mission_id, lifecycle state ∈ INTENT|BOUND|ROLLED_BACK
  (unknown state can never reconcile into BOUND), payload-key identity,
  and bidirectional assignee↔org_agent equality. R3 §1 splits the
  validator into explicit `mode: "ADMISSION"` (new-mission minting —
  bound agent must currently be ACTIVE) vs `mode: "PROVENANCE"`
  (proving an already-created mission — agent must resolve + same
  business but PAUSED/TERMINATED cannot erase provenance); safety
  actions, completion fold, review grounding and crash-adopt all run
  PROVENANCE (R3 §3-§6).
- **Proof derives from the binding, never metadata**:
  `missionBoundToWorkItem` requires BOUND binding + mission/work_item/
  business/project agreement; `syncWorkItem`, `blockWorkItem`,
  `cancelWorkItem`, `reviewWorkItem`, `reconcileOpenIntent` all consume
  the same predicate — forged metadata and foreign missions carry zero
  authority and quarantine (`TERMINAL_PROVENANCE_CORRUPT`) instead.
- **Crash boundaries**: no-mission intent → rollback + `ROLLED_BACK`;
  post-mission crash → adopt ONLY the pinned mission (link+BOUND in one
  txn); post-BOUND → idempotent; restart-safe, no dup missions/events.
- **Minimal review grounding**: `REVIEW_REQUIRED` (new status) acts only
  when grounded in the item's own bound COMPLETED mission; ungrounded
  review state fails ACCEPT+REWORK closed with no decision evidence.
- Evidence: `PAIR_OS_VNEXT_P14_FOUNDATION_V2_REPORT.md`; suite
  `pair-p14-foundation.test.ts` (FOUND-V2-* ×10 + FOUND-R1-* ×10 +
  FOUND-R2-* ×8 + FOUND-R3-* ×7).
  Classification: **`P14_FOUNDATION_V2_REMEDIATED_R3_FINAL_PENDING_AUDIT`**
  — MERGED into `main` (`fff2ee4`).

### PRE-P14-WORKFORCE RUNTIME HARDENING (branch, pending audit)

Two inherited runtime defects fixed on
`devin/1790726448-pre-p14-runtime-hardening` from canonical base
`fff2ee4852231cbabed9c084fae61f8497f2acf8` — **no Workforce V2, no
P15/P16**:

- **A — `FAIL_CLOSED_MODEL_REMOVED` boot crash-loop closed**: the
  serve-script route loop skips catalog entries whose `conditions`
  include `REMOVED` *before* `probeModel` (which correctly fail-closes on
  them for direct callers). REMOVED = NOT ROUTABLE (the
  `MODEL_NOT_REMOVED` qualify gate still applies); boot continues; no
  error is caught or swallowed — unrelated `IntegrityError`/`PolicyError`
  still propagate fail-closed.
- **B — orphan mission recovery (R1: CREATED-only reconstruction)**:
  `MissionSupervisor.resume()` scans the canonical `mission` list.
  **`mission.status === CREATED` + missing `mission_runtime` is the only
  automatically reconstructable state** — the sole status provably inside
  the original crash window; `runtimeEntity` (idempotent, version-0 CAS)
  rebuilds it and the mission continues via the standard
  RESTART_REHYDRATE wake + supervisor tick path. **READY/RUNNING/PAUSED +
  missing runtime is ambiguous and fails closed**: `restart_blocker`
  (`FAIL_CLOSED_RUNTIME_AMBIGUOUS` + observed status) stamped on the
  canonical `mission_recovery_checkpoint` + `MISSION_RUNTIME_AMBIGUOUS`
  event — no runtime row, no wake, no auto-run, no replay of uncertain
  in-flight execution; PAUSED authority stays in effect and operator
  recovery goes through existing governed controls. Unknown/malformed
  mission status fails closed identically (`UNKNOWN:<status>`). Terminal
  missions never resurrect; existing runtimes never duplicated. No second
  scheduler/router/dispatcher/recovery engine.
- Evidence: `PAIR_OS_VNEXT_PRE_P14_WORKFORCE_RUNTIME_HARDENING_REPORT.md`;
  suite `pair-runtime-hardening.test.ts` (RH-R1-* ×11).
  Classification: **`PRE_P14_WORKFORCE_RUNTIME_HARDENING_REMEDIATED_R1_PENDING_AUDIT`**.

## P14 Workforce V2 Phase 1 state (MERGED via PR #12 → `41934b2`)

**Clean rebaseline on `devin/1790741859-p14-wfv2-p1-rebaseline`** — PR #11
(`devin/1790731419-p14-workforce-v2-p1`, head `44f7166`) was abandoned as
**reference only** after its final independent audit found a systemic
inverse-provenance omission (deleting mutable mirror fields could degrade
a governed work item to "standalone") and an insufficiently anchored
historical authority ceiling (a caller could swap the persisted snapshot
and recompute digests). Proven ideas were selectively re-derived —
deterministic child ids, proposal digest, `work_dependency_set` (WDS)
manifests, atomic seams, assignee immutability, ADMISSION-vs-PROVENANCE,
open-time ceiling, graph bounds — around two new canonical designs:

- **`work_graph_membership` (`WGM_<work_item_id>`)** — bidirectional graph
  authority. Written atomically with every work item (`STANDALONE`) and
  every canonical governance row (`DELEGATED_CHILD`, `DECOMPOSED_CHILD`,
  `GRAPH_PARENT`). `assertCanonicalMembership` re-proves the full chain
  (key, digest, type-dispatched WDEL/WDEC/WDS/WAB validation, mirror-field
  agreement, universal parent facet). Direction 2: committed canonical
  rows governing an item without membership — or membership disagreeing
  with them — fail closed; an item can never become standalone because its
  mirror fields were deleted or altered.
- **`work_authority_binding` (`WAB_<work_item_id>`) + `agent_contract_revision`
  (`ACR_<contract>_<version>`)** — historically anchored execution ceiling.
  The WAB pins `ceiling_agent_id`, `contract_id`, `contract_version`,
  `contract_digest`, the normalized snapshot + digest, and a binding
  digest over all anchors. R1 closure: `assertCanonicalContractRevision`
  fully re-validates the pinned revision (deterministic key, COMMITTED,
  normalized policy, `contractDigest` recomputed over the stored policy —
  a mutated policy with an unchanged digest field fails; journal anchor
  required). The stored snapshot must be ⊆ the canonical P12 projection
  (`projectedAuthorityFromPolicy` — the same derivation `effectiveAuthority`
  uses, so `null` allow + explicit deny = catalog minus denies; routes use
  `preferred_route_ids`/`denied_route_ids`/`route_fallback_allowed`, no
  invented allow field). An append-only `WORK_AUTHORITY_BOUND` journal
  event at binding commit pins every field — a self-consistent rehash of
  the mutable WAB row (even policy-consistent) still fails the anchor.
  `ensureCurrentRevision` backfills the exact CURRENT revision under
  create-only CAS for pre-ACR contracts when the journal already proves
  the version+digest; conflicting ACRs fail closed, never overwritten;
  older history is never fabricated.
- **Dependency authority:** WDS manifests (explicit empty set included)
  remain the sole proof of a node's dependency list — a WGE scan alone
  never establishes "no dependencies". **Reconcile** validates WGE/WDEL/
  WDEC/WDS/WGM/WAB rows and sweeps all work items bidirectionally;
  corrupt canonical rows poison both endpoints; never rebuilt from
  mutable mirrors; idempotent across restarts.
- R2 closure: contract-version commits are crash-atomic —
  `materialize()`/`update()` write the `agent_execution_contract` row,
  `ACR_<contract>_<version>` and the canonical contract journal event in
  ONE `store.immediate()` (rollback leaves the old complete revision or
  the new complete revision, never a partial). `writeRevision` on an
  existing ACR runs `assertCanonicalContractRevision` + field-for-field
  identical match (conflict → `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT`,
  never overwritten); CAS semantics preserved (one winner, loser
  `FAIL_CLOSED_VERSION_CONFLICT`, no orphan ACR/event). Status-only
  toggles unchanged; R1 `ensureCurrentRevision` legacy backfill kept —
  new writes never rely on it.
- Evidence: `PAIR_OS_VNEXT_P14_WORKFORCE_V2_PHASE1_REBASELINE_REPORT.md`
  (§R1, §R2); suite `pair-p14-workforce-v2.test.ts` (73 — incl. 10
  `P14RB-R1-*` anchor/deny/backfill + 8 `P14RB-R2-*` crash-atomicity
  tests) + fresh-server E2E (ACR-policy tamper poisons both bindings,
  self-consistent WAB rehash fails at the event anchor,
  restart-quarantine durable) + upgrade E2E (pre-ACR DB → exact current
  revision backfilled, open succeeds) + restart/crash E2E (injected
  failure mid-update → old v2 canonical, retry → one complete v3).
  Classification: **`P14_WORKFORCE_V2_PHASE1_REBASELINED_R2_PENDING_FINAL_AUDIT`**.

## P14 Workforce V2 Phase 2 state (MERGED via PR #13 → `1add96d`)

**Coordination layer** (base `41934b2` =
merged Phase 1) — canonical claim lease + heartbeat/fencing + durable
inbox. Coordination only: nothing in this phase creates missions,
satisfies dependencies, accepts reviews, or bypasses
`openWorkItem → work_open_binding → Planner → MissionRouter →
GovernedTaskGate → executor`.

- **`work_claim_lease` (`WCL_<work_item_id>`)** — one lease per item;
  `lease_epoch` +1 on every reclaim; only `token_digest`
  (`digest("work-claim-token:"+token)`) is persisted — the raw token is
  returned once at claim and stripped recursively from every other
  response. `assertCanonicalClaimLease` re-proves id, state enum,
  business/project, claimant, ACTIVE⇒claimant==assignee, epoch,
  `issued≤hb`, `exp>issued`, digest, ACTIVE+mirror agreement — consumed
  at claim/heartbeat/release/open/assign/cancel/sync/reconcile.
- **Heartbeat/renewal:** `POST /api/work-items/:id/heartbeat` validates
  claimant + token digest + epoch + liveness, renews a server-bounded TTL
  (`PAIR_WORK_ITEM_CLAIM_MS`, default 30 min; no caller TTL, no
  rotation). Expired ACTIVE leases fence to EXPIRED inside the commit
  (marker thrown after commit so the fence persists).
- **Release/reclaim:** token-matched release → RELEASED + mirror clear;
  expired/RELEASED → reclaim mints epoch+1 and a fresh token — stale
  tokens die at the digest+epoch fence. `cancelWorkItem` revokes;
  `syncWorkItem` releases terminal-item leases in the same txn.
- **openWorkItem:** no hidden token mint. `assertNoForeignLiveLease`
  blocks live foreign claims (`FAIL_CLOSED_WORK_ITEM_CLAIMED`), fences
  expired ones, clears phantom mirrors — legacy mirror fields are never
  authority and never fabricate a WCL.
- **Durable inbox:** `workforce_message` (`WFM_<id>`, append-only
  COMMITTED, kinds NOTE/REQUEST/STATUS/BLOCKER_NOTICE/HANDOFF_REQUEST) +
  `workforce_message_receipt` (`WIR_<msg>_<recipient>`, exact-recipient
  idempotent ACK). HANDOFF_REQUEST mutates nothing.
- **Reconcile:** WCL validation (corrupt → quarantine), deterministic
  expiry fencing, mirror repair, message/receipt validation —
  idempotent, never fabricates, never terminates missions.
- **R1 — atomic admission + immutable provenance:**
  - `claimWorkItem`: the decisive admission proof (work_item, business,
    WGM/graph authority, status, assignee, org_agent ACTIVE,
    `assertExecutable`, existing WCL) is re-run **inside** the
    `immediate()` that writes the lease — preflight outside is fast-path
    only, not authority (TOCTOU closed).
  - `assignWorkItem`: re-read + quarantine + graph authority + assignee
    immutability + agent + transition + `leaseGateInTxn` + assignee CAS
    in ONE `immediate()` — `assignee=B ∧ ACTIVE WCL(A)` unreachable.
  - Lease validator requires `issued <= hb < expires_at` strictly.
  - `WORKFORCE_MESSAGE_SENT` pins the full message identity +
    `message_digest` + receipt anchor; `WORKFORCE_MESSAGE_ACKNOWLEDGED`
    pins `message_id + recipient + acknowledged_at` — tamper-and-rehash
    fails at the event anchor; direct row ACK without event fails.
  - Read seams (`listWorkItemMessages`, `inboxForAgent`,
    `getWorkItemClaim`) validate before returning — corrupt rows surface
    as explicit CORRUPT markers, never as valid content.
  - `reconcileWorkGraph` appends `WORK_COORDINATION_CORRUPT` at most once
    per row — repeated passes are no-ops.
- Evidence: `PAIR_OS_VNEXT_P14_WORKFORCE_V2_PHASE2_REPORT.md` (§R1);
  suite `pair-p14-wfv2-p2.test.ts` (50 — 40 `P14-P2-*` + 10
  `P14-P2-R1-*` incl. genuine worker_threads races) + fresh-server E2E
  sequences A–E + restart evidence.
  Classification: **`P14_WORKFORCE_V2_PHASE2_R2_PENDING_FINAL_AUDIT`**.

## P14 Workforce V2 Phase 3 state (MERGED via PR #14 → `6f389c9`)

**Completion lifecycle** (base `1add96d` = merged Phase 2, merge commit
`6f389c91aabf14768d09912f1efc3d962fb1ec4a` — independently audited R4
PASS) — canonical completion proof + review/
acceptance + restart-safe finalization. Invariant: no work item becomes
canonically complete because a mutable status says DONE — completion
authority derives only from canonical evidence.

- **`work_completion` (`WCP_<work_item_id>`)** — deterministic id,
  COMMITTED, written only inside the same `immediate()` txn that
  projects the item DONE; pins `mission_id + bound_open_id +
  child_work_item_ids + reviewer_agent_id` under `completion_digest`;
  exactly-one `WORK_ITEM_COMPLETED` event anchors every pin; the
  canonical validator re-derives digests, proves the bound-mission
  chain (full `validateWorkOpenBinding` PROVENANCE), recurses the
  canonical child set, and requires a pinning `WORK_REVIEW_ACCEPTED`
  for review-gated completions.
- **Canonical child set** derives from COMMITTED+validated WDEC ∪ WDEL
  — never mutable mirrors. Parents aggregate only over that set;
  mixed parents need their own bound mission too.
- **Review seam**: `requires_review` items fold to REVIEW_REQUIRED
  (no WCP) until a canonical ACCEPT; ACCEPT/REWORK race collapses to
  exactly one outcome; replayed ACCEPT is idempotent (no second event);
  REWORK never reuses the old completion proof.
- **Dependency satisfaction** consumes `proveWorkItemDone` — only
  canonical completion satisfies an edge; status text, heartbeats,
  claim release, message ACKs, review requests satisfy nothing.
- **Restart-safe**: `reconcileWorkLifecycle` (inside
  `reconcileWorkGraph`, runs at boot) resumes interrupted finalization
  at every crash boundary — folds terminal bound missions, resumes the
  parent cascade, materializes ACCEPT-pinned projections exactly once,
  quarantines ungrounded REVIEW_REQUIRED/DONE and malformed WCPs, and
  never fabricates evidence.
- Endpoints: `POST /api/work-items/:id/review`,
  `GET /api/work-items/:id/completion`.
- **R1 remediation** (after independent audit BLOCKED):
  `assertCanonicalMissionCompletion` is the ONE mission-success proof
  consumed by every completion seam — mission COMPLETED + legal
  MISSION_TRANSITION event + `MRT_<mid>` COMPLETED + pinned
  MISSION_RUNTIME_TRANSITION ("all_tasks_completed") + current-plan
  tasks all COMPLETED with execution-correlated TASK_COMPLETED.
  Bare `mission.status` forgery fails closed everywhere.
  `reviewWorkItem` re-reads and re-proves the CURRENT reviewer inside
  the commit txn (racing pause/terminate loses).
  REWORK pins the rejected basis identity
  (`completionBasisDigest` = bound mission + bound_open + per-child WCP
  digest set); the basis must advance before REVIEW_REQUIRED can
  re-enter — unchanged children can never re-ground review.
- **R2 remediation** (after second independent audit BLOCKED):
  mission success now proves the governed result-validation chain per
  task — `executor_execution` (mission+task+plan revision+correlation,
  COMPLETED result) bound to a `governed_task`
  (`DISPATCH_AUTHORIZED`, binds mission/task/plan/executor/correlation),
  `executor_dispatch_intent` EXECUTION_PERSISTED→that execution,
  `EXECUTION_DISPATCHED` + `GOVERNED_TASK_VALIDATED` events, a canonical
  `execution_validation` `status: PASS` on that exact execution, and a
  `RESULT_VALIDATED` event pinning `validation_id` + correlation.
  Missing/FAIL validation or a foreign governed task fails closed.
  `WORK_REWORK_REQUESTED` now persists the canonical sorted
  `child_work_item_ids` — the event self-validates (sorted shape +
  digest recompute); malformed REWORK evidence fails closed, never
  silently swallowed. New canonical children legitimately advance a
  container's basis past a rejected pin (DONE is terminal —
  `delegateWorkItem` under a new completion authority unfences
  REVIEW_REQUIRED; same-basis stays fenced).
- **R3 remediation**: the task authority is the canonical plan
  manifest — `plan.task_ids` on the exact active `plan` entity
  (hash-verified `mission_plan_revisions` → plan row exists, claims
  this mission, PLANNED; mission.plan_id/plan_revision pins; exactly-one
  `MISSION_PLAN_COMMITTED` anchor pinning plan_id+revision), never a
  task-table scan. Live tasks claiming mission+plan must equal the
  declared set exactly: omitted declared task, drifted declared task,
  injected undeclared task, missing/foreign plan row, forged
  commit-anchor metadata — all fail closed.
- **R4 remediation**: the complete task manifest is now pinned
  immutably inside `MISSION_PLAN_COMMITTED`
  (`metadata.task_ids` ordered + `plan_manifest_digest` recomputed on
  every anchor by the validator) — live `plan.task_ids` must equal the
  committed set exactly; shrink/reorder/expand/digest-tamper fail
  closed. Revision history is omission-safe: hash-verified
  `mission_plan_revisions` in exact ordered bijection with commit
  anchors, contiguous revisions, active = highest committed — a deleted
  latest row can never roll history back.
- Evidence: `PAIR_OS_VNEXT_P14_WORKFORCE_V2_PHASE3_REPORT.md`; suite
  `pair-p14-wfv2-p3.test.ts` (68 total — R1+R2+R3 suites preserved +
  9 `P14-P3-R4-*`; genuine worker_thread races)
  + fresh-dir E2E 39/39 (real server: forge/missing+FAIL validation/
  omitted task/shrunk manifest/deleted revision rollback → quarantine;
  intact manifest completes; reviewer race; fence/unfence; 3 restarts;
  zero dup evidence).
  Classification (phase level, superseded by the final closure below):
  **`P14_WORKFORCE_V2_PHASE3_R4_PENDING_FINAL_AUDIT`**.

## P14 Workforce V2 FINAL CLOSURE (MERGED via PR #15 — `P14_WORKFORCE_V2_OFFICIAL_FINAL_PASS`)

Final cross-phase closure audit + hardening over the integrated
P1+P2+P3 stack — base `6f389c9` (merged R4 PASS), branch
`devin/1790765918-p14-final-closure`. No new features, no redesign —
audit + one narrow defect remediation.

- **Execution path verified singular**: work item → `openWorkItem` →
  `work_open_binding` (INTENT pins mission_id) →
  `MissionControl.startBoundMission` (binding PROVENANCE then
  ADMISSION) → `startMissionInternal` → Planner → MissionRouter →
  GovernedTaskGate → MissionRuntime/executor. No second planner,
  router, scheduler, runtime, execution or completion authority.
- **Cross-phase defect found + fixed (routine mirrors)**: P11's
  `syncRoutineWorkItems` projects schedule-fired missions to
  `work_item` rows directly — unbound, no membership, no WCP possible
  by design. The P3 seams quarantined every routine mirror (unbound
  IN_PROGRESS via `syncWorkItem`; DONE-without-WCP via
  `reconcileWorkLifecycle`). Fix: mirrors are mission-status mirrors —
  honest iff they replicate the mission's OWN canonical proof
  (`proveCanonicalMissionCompletion`); they NEVER mint WCP and carry
  zero item-level completion authority (dependency oracle, review,
  parent aggregation untouched). Unproven `COMPLETED` claims project
  IN_PROGRESS and quarantine on the same-render fold; unbound
  non-routine links still quarantine on all statuses; reopened
  mirrors flow through the canonical bound path and CAN mint a real
  WCP. Five `P14-FC-ROUTINE-*` tests.
- **Golden E2E 44/44** (real `dist/` server, fresh dir, 6 restarts):
  parent → decompose A, B(dep A), C(requires_review), D(dep B+C) +
  delegated E; claims/heartbeat; openWorkItem→binding→bound mission;
  canonical validated execution per child; A WCP → B eligible; C →
  REVIEW_REQUIRED → ACCEPT → WCP; D eligible only after B+C; parent
  aggregates all 5 canonical children (WDEC∪WDEL) → DONE+WCP;
  exactly-one WCP/anchor/ACCEPT per item. Negatives proven live:
  heartbeat ≠ dependency, message ACK ≠ completion, HANDOFF_REQUEST ≠
  authority (non-assignee claim rejected), DONE-without-WCP ≠
  dependency, forged mission completion → quarantine no WCP,
  forged DONE quarantined at restart, reopen-DONE fails, concurrent
  opens mint exactly one mission, routine mirror never quarantined.
- **Restart boundaries A–E** (after binding / mission-complete /
  child-WCP / review-ACCEPT / final-child): zero duplicate missions,
  bindings, dispatches, WCPs, ACCEPTs or WORK_ITEM_COMPLETED anchors;
  no fabricated review or graph authority.
- **Regression**: P3 73 · P2 55 · Phase1/WFV2 73 · P14F 35 · RH 11 ·
  P13 67 · P12 71 · P11+r 91 · P10 31 · P9 79 · P6 36 — all green.
  Node 22 full 2170 + 2 pre-existing P5 env-gap fails (unchanged,
  DSH/CODEX executables absent); Node 20 full 2172/0; `tsc --noEmit`
  clean; `pnpm build` PASS; `pnpm audit` 0 high; `verifyIntegrity`
  PASS.
- Report: `PAIR_OS_VNEXT_P14_FINAL_CLOSURE_REPORT.md`.
  Classification: **`P14_WORKFORCE_V2_OFFICIAL_FINAL_PASS`**. PR #15
  merged into `main` at `6de10d59194230f6b5c141d522dcde87df096304`;
  independently audited R5 head `45896d70a25340fa26e64c34fd47e9733848a648`.
  P14 Workforce V2 (Phase 1 + 2 + 3 + FINAL CLOSURE) is the official
  runtime on main.

#### FC R1 remediation (independent-audit BLOCKED → closed, same PR)

Two routine-boundary defects remediated narrowly (zero redesign):

- **Routine identity ← canonical schedule evidence only**: caller-set
  `metadata.schedule_id`/`business_id` was the projection trigger — a
  forgeable label. Now ONE validator (`routine-mirror.ts`:
  `assertCanonicalRoutineMirror`/`assertCanonicalRoutineFire`) proves
  the full chain: routine row → mission_schedule →
  `schedule_occurrence` FIRED + `mission_id` binding → mission
  metadata 4-pin (`schedule_id`, `schedule_occurrence_id`,
  `scheduled_for==due_at`, business scope) → recomputable
  `schedule_digest` → exactly-one `SCHEDULE_FIRED` anchor →
  deterministic `WI_RT_<digest(mission)>` id → `WORK_ITEM_CREATED`
  agreement. Every exception seam consumes it (`syncWorkItem`,
  `syncRoutineMirror`, `reconcileWorkLifecycle`, projection,
  promotion); invalid provenance → quarantine. Non-canonical claimant
  missions simply never project. All routine test fixtures now drive
  genuine `fireDue` (no caller-metadata fires anywhere).
- **Promotion enters Phase-1 authority**: projection now commits the
  mirror + deterministic STANDALONE `work_graph_membership` atomically;
  `openWorkItem` runs `promoteRoutineMirror` BEFORE any open
  intent/binding/mission — re-proves provenance + validates the
  existing WGM via `assertCanonicalMembership` inside the txn (CAS-
  loser adopts the winner row; tampered/fabricated rows fail closed;
  legacy mirrors get the deterministic WGM written). Exactly-one
  canonical membership, restart idempotent, cross-connection safe, no
  fabricated WDEL/WDEC/WDS/WAB, `assertGraphAuthority` unweakened.
  Mirror still zero completion authority until promoted via the normal
  bound path.
- **15 `P14-FC-R1-*` tests** (9 provenance + 6 membership); Golden E2E
  extended to **53/53** (caller-metadata forgery negative + genuine
  two-occurrence lifecycle: fire→mirror→DONE zero-WCP→restart honest
  →fire2→FAIL→BLOCKED→promote→WGM+binding→WCP→restart zero-dup).
- Regression re-run all green (N22 2185+2 pre-existing P5 env-gap /
  N20 2187/0); report §18-19.

#### FC R2 remediation (independent-audit BLOCKED → closed, same PR)

One mission-lineage gap remediated narrowly (zero redesign): the R1
validator proved `mission_ids[0]` while authority seams consumed
`mission_ids[last]` — an appended foreign terminal mission could fold
mirror state and hide a live scheduler mission from the open gate.

- **Canonical routine mission-lineage proof**
  (`assertCanonicalRoutineLineage`): display-only mirror ⇒
  `mission_ids` exactly `[projected_scheduler_mission]`; promoted ⇒
  `mids[0]` stays projected + every trailing id is a canonical bound
  attempt of the SAME item (mission row + `bound_open_id` +
  `validateWorkOpenBindingById` BOUND/PROVENANCE for exact
  item/mission/business/project + non-decreasing `bound_at` history
  order; WORK_ITEM_OPENED not required — reconcile path doesn't write
  it, binding is the authority). Any violation → quarantine, no
  fold/open/binding/mission/WCP.
- **All seams consume it**: `syncWorkItem` routine exception only when
  `mids.length===1` AND lineage proof (last==projected);
  `syncRoutineMirror` asserts lineage + `mids.length===1`;
  `reconcileWorkLifecycle` routine-DONE same; `promoteRoutineMirror`
  re-asserts before WGM. Foreign tail hiding a live mission → open
  fails closed (zero intent/binding/mission/dispatch).
- **Direct project pin**: `mission.project_id === schedule.project_id
  === business.project_id` + `business_context.business_id` +
  `occurrence.business_id === routine.business_id`.
- **9 `P14-FC-R2-*` tests**; Golden E2E **60/60** (foreign tail →
  restart quarantine → open fail-closed zero mints → legitimate reopen
  still succeeds → `verifyIntegrity` 0 errors).
- Regression **658/658**; N22 2194+2 pre-existing P5 env-gap / N20
  2196/0; report §20-21.

#### FC R3 remediation (independent-audit BLOCKED → closed, same PR)

Core mission lifecycle / replacement-authority defect remediated: the
mutable `mission.status` field was terminal authority at the open
gate and at the FAILED/CANCELLED/PAUSED sync folds — a bound or
scheduler mission RUNNING + runtime RUNNING could be replaced by
mutating one field, and routine seriality trusted `bound_at`
ordering alone.

- **One canonical lifecycle proof** (`assertCanonicalMissionLifecycle`
  / `proveCanonicalMissionTerminalForReplacement` in work-completion):
  status claim + exactly-one legal `MISSION_TRANSITION` into it +
  `MRT_<mid>` row (identity pinned) in a canonical pairing + exactly-one
  legal `MISSION_RUNTIME_TRANSITION` (mission_id-pinned) + no
  contradictory later evidence + no live `executor_execution` where
  semantics forbid (exempt: the ABORTED pairing and
  `cancel_requested`-marked side-effects). Pairings surveyed from the
  canonical writers: COMPLETED↔COMPLETED (delegates to the unchanged
  completion proof), FAILED↔{FAILED,ABORTED},
  CANCELLED↔{CANCELLED,ABORTED}, PAUSED↔{PAUSED,CREATED} (pause-before-
  runtime-start mints MRT at CREATED — creation anchor required,
  transitions forbidden).
- **Open gate**: every linked mission must be canonically terminal or
  canonically live before ANY authority write — claims-terminal-
  unproven → `FAIL_CLOSED_MISSION_LIFECYCLE_CORRUPT`; live →
  `FAIL_CLOSED_MISSION_ACTIVE`; zero intent/reservation/WOB/mission/
  dispatch on failure.
- **Folds**: `syncWorkItem`, `syncRoutineMirror` and the projection
  path all consume the same proof — status-only FAILED/CANCELLED/
  PAUSED → `TERMINAL_PROVENANCE_CORRUPT` quarantine, never a fold,
  never fabricated evidence; unproven claims project IN_PROGRESS.
- **Seriality**: `assertCanonicalRoutineLineage` requires every
  mission before the final attempt canonically terminal — scheduler
  before bound1, bound1 before bound2 — independent of `bound_at`.
- **§9 helpers migrated**: `canonicallyTerminateMission` drives BOTH
  state machines (legal mission transitions + MRT mint + legal runtime
  hops to the canonical pairing); all status-only fixtures converted.
- **12 `P14-FC-R3-*` tests**; Golden E2E **65/65** (forge-on-live-bound
  → quarantine + fail-closed open zero mints; forged scheduler FAILED →
  quarantined mirror never BLOCKED/no reopen; real canonical failure →
  reopen exactly once → second open denied).
- Regression **670/670**; N22 2206+2 pre-existing P5 env-gap / N20
  2208/0; report §22-23.

#### FC R4 remediation (independent-audit BLOCKED → closed, same PR)

Omission-safe attempt-history closure: a missing linked mission row
was silently skipped at the open gate (`if (!pm) continue`), and the
mutable `work_item.mission_ids` projection was the attempt-history
authority at open/sync/completion seams.

- **Canonical attempt history** (`canonicalBoundAttemptsForWorkItem` +
  `assertCanonicalWorkMissionLineage` in work-completion): attempts
  derive ONLY from BOUND `work_open_binding` rows ordered by ULID
  `open_id` (canonical open order); each validates the full WOB
  provenance chain; every attempt's mission row must exist (missing
  row is never "terminal"); `mission_ids` must AGREE exactly —
  omission, injection, duplicates, reorders, foreign attempts all
  fail as `FAIL_CLOSED_MISSION_LIFECYCLE_CORRUPT`. Routine items keep
  the R1–R3 model (`mids[0]` scheduler mission, `mids[1..]` = WOB
  tails).
- **Open gate**: lineage proof BEFORE any authority write; then every
  canonical attempt — R3-terminal → continue; live → `MISSION_ACTIVE`;
  missing/corrupt → `MISSION_LIFECYCLE_CORRUPT`; zero intent/
  reservation/WOB/mission/dispatch.
- **Sync + current attempt**: `syncWorkItem` checks lineage before any
  fold (violation → quarantine); `boundMissionForWorkItem` returns the
  canonically-latest WOB attempt — array order can never select an
  older attempt as current (completion basis, cancel, block).
- **10 `P14-FC-R4-*` tests**; Golden E2E **68/68** (deleted mission
  row / truncated mission_ids → open fail-closed zero mints; canonical
  terminal → legitimate ordered reopen).
- Regression all-green; N22 2216+2 pre-existing P5 env-gap / N20
  2218/0; report §24-25.

#### FC R5 remediation (independent-audit BLOCKED → closed, same PR)

Historical assignee provenance closure: R4's lineage validator
revalidated every BOUND WOB against the CURRENT assignee — but a WOB
pins the assignee AT THAT ATTEMPT, and a STANDALONE item may legally
be reassigned between attempts; reassigning A→B falsely corrupted
WOB1(A) and refused a legitimate retry.

- **Three-way binding-validation mode**
  (`validateWorkOpenBinding`): `ADMISSION` — new-mission minting
  requires agent == current assignee + ACTIVE; `PROVENANCE` —
  current-attempt origin proof keeps agent == current assignee;
  `PROVENANCE_HISTORICAL` (new) — past attempts skip ONLY the
  current-assignee equality while still requiring the pinned
  org_agent to resolve and belong to the binding's business (all
  other pins unchanged: open_id, BOUND, work_item/business/project,
  reserved mission id, bound_open_id, mission project).
- **Consumption**: `assertCanonicalWorkMissionLineage` + routine tail
  validation → `PROVENANCE_HISTORICAL`; `missionBoundToWorkItem`,
  `reconcileOpenIntent`, `startBoundMission` unchanged
  (`PROVENANCE`/`ADMISSION`) — no global weakening; graph-bound
  assignee immutability untouched (delegated/decomposition child
  reassign → `FAIL_CLOSED_WORK_GRAPH_ASSIGNEE_IMMUTABLE`).
- **8 `P14-FC-R5-*` tests** (P3 suite 127/127); Golden E2E **70/70**
  (A→fail→BLOCKED→reassign B→open: WOB1(A) historical-valid, WOB2(B)
  current, exactly one new mission; delegated child reassign → 409).
- Regression **688/688**; N22 2224+2 pre-existing P5 env-gap / N20
  2226/0; tsc clean; build PASS; audit 0 high; verifyIntegrity PASS;
  report §26-27.

## Live Ops Recovery Closure (branch `devin/1790855402-live-ops-recovery-closure`, pending independent audit)

- **Bug C — apply-path limbo closed**: all three recovery apply-path
  `routeGovernedTask` calls (RETRY_SAME_ROUTE, RE_ROUTE, remediation
  bind) funnel throws into `handleRecoveryApplyFailure`. Expected
  governed PolicyErrors become `infeasible_actions` evidence persisted on
  `pending_recovery` and fed into the canonical `decide()` — rejected
  `APPLY_INFEASIBLE:<code>`, next matrix action evaluated, bounded
  convergence to HUMAN_APPROVAL_REQUIRED/ABORT/terminal. Defects
  (IntegrityError etc.) re-decide under INTERNAL_RUNTIME_DEFECT.
  `supersedeGovernedTask` is idempotent within a failure chain.
- **Devin completion protocol**: governed `PAIR_EXECUTION_COMPLETE`
  marker (own line) is the completion contract; legacy bare-DONE is the
  fallback tier. Verified completion wins over blocked/suspended/timeout
  enum lag — the remote fetch now runs even past the persisted budget.
  Outbox artifacts alone are not completion evidence (deferred: needs a
  per-task expected-artifact contract).
- Validation: focused +16; full suite 2426/2 pre-existing env fails;
  tsc + build clean. DO NOT MERGE — pending independent audit.

## Route Capability Authority & Staleness Closure (MERGED via PR #24 → `152d8d3`)

- Route `capabilities` is a pure constraint (`EXECUTOR_DECLARED` → `[]`
  unrestricted / `ROUTE_EXPLICIT` → `capabilities_declared` ceiling);
  `binding.capabilities` is the effective capability surface
  (executor declaration ∩ route ceiling), recomputed at every
  registration — shared routes stay order-independent. Reconcile runs at
  the registration seam even on unqualified boots (never mints routes or
  bindings for never-qualified executors); CAS +
  `BINDING_CAPABILITIES_RECONCILED` event only on semantic change;
  `RouteSelector` executor-bound reads `binding.capabilities`; explicit
  empty ceiling (`ROUTE_EXPLICIT` + `[]`) permits nothing on
  direct-callable routes.
- `NO_ELIGIBLE_ROUTE` split: all-policy rejection codes
  (`AGENT_CONTRACT_ROUTE_DENIED`/`_RESTRICTED`, `OPERATOR_PIN_EXCLUDED`)
  keep `FAIL_CLOSED_NO_ELIGIBLE_ROUTE` → `POLICY_DENIAL` → ABORT;
  route-local infeasibility throws `FAIL_CLOSED_ROUTE_INFEASIBLE` → new
  `ROUTE_INFEASIBLE` class → bounded `RE_ROUTE → RECONCILIATION_REQUIRED
  → ABORT`. `PairError.meta` carries structured evidence
  (`executor_id`, `route_decision_id`); dispatch-arm recovery persists
  the failed executor even without an execution row, so bounded RE_ROUTE
  excludes it.
- Validation: focused 11/11; full suite 2441/2 pre-existing env fails;
  tsc + build clean. Counterfactual on `c06b43b`: 8/11 fail (R1 proves
  the stale persisted snapshot). MERGED.

## Phase C — Governed DSH Multi-Model Routing (branch `devin/post-p14-phase-c-dsh-model-routing-v2`, pending independent audit)

- New `src/pair/dsh-model-router.ts`: canonical ordered model pool
  (`PAIR_DSH_MODEL_ROUTE → PAIR_DSH_FALLBACK_ROUTE → PAIR_DSH_EXTRA_ROUTES`,
  dedupe AFTER canonical `model_entry_id` resolution, unresolved ref fails
  closed at boot), per-invocation eligibility re-proof
  (`assertDshCandidateEligible` — role / planner-overlap / provider /
  executor / QUALIFIED binding as AUTHORITY throws vs health-availability
  rejects that may fail over), shared task.timeout deadline across the
  pool, `classifyError` with the `proc.prompt` markDispatch boundary
  (dispatched → never failover).
- `DshExecutorAdapter`: `bindModelRouter` + `runAttempts` loop injects the
  explicitly selected model `{provider, model, model_entry_id,
  model_binding_id}` and pins it via `session/set_config_option`
  (config_id `model`); credential env follows the candidate's provider
  (never the primary's); `DSH_DEFAULT_MODEL_ROUTE`/`modelRoute(env)` no
  longer grant runtime model authority (`governed:false` only on the
  unbound probe path).
- `dsh_model_attempt` (`DMA_*`) provenance per candidate: 24 fields incl.
  `generic_route_id`/`executor_supply_binding_id` linkage,
  `dispatch_state`, `safe_to_failover`, `winner` (≤1 per governed task);
  events `DSH_MODEL_ATTEMPT_STARTED|FAILED|SUCCEEDED`; crash leaves
  STARTED. Exhaustion → `FAIL_CLOSED_DSH_MODEL_EXHAUSTED` with safe
  evidence.
- `AcpExecutorAdapterBase`: minimal `AcpAttemptContext`/`runAttempts`
  seam; single-attempt default unchanged for Codex.
- Zero semantic changes to route-registry / route-selector /
  multi-executor / mission-router / mission-runtime / recovery-controller.
- Validation: focused 42/42 (groups A–K); full suite 2517 pass / 2
  pre-existing env P5 failures (real dsh/codex binaries on PATH); tsc +
  build clean. Live E2E on isolated `PAIR_MC_DIR` ×4: primary win, safe
  pre-dispatch failover, post-dispatch no-failover + bounded recovery,
  generic-gate mismatch with zero model attempts. DO NOT MERGE — pending
  audit. See `PAIR_NEXT_POST_P14_PHASE_C_DSH_MODEL_ROUTING_REPORT.md`.

## Phase E — Provider / Model Operational Authority Closure (branch `devin/1790938483-phase-e`, pending independent audit)

- `DISCOVERY_ELIGIBLE` lifecycle state: enumeration-only bootstrap (scanned
  by `PROVIDER_DISCOVERY_SCAN_STATES`, NOT in `PROVIDER_OK_STATES`). The
  unconditional `setLifecycle(MODEL_DISCOVERY_ELIGIBLE)` shortcut is gone —
  `MODEL_DISCOVERY_ELIGIBLE` now requires a canonical `provider_qualification`
  receipt bound by `material_fingerprint`.
- Source-aware provider absence reconciliation: per-source COMPLETE/FAILED
  `provider_snapshot` rows drive `reconcileProviderAbsence` — absent from
  ALL completed sources → `absence_streak` → STALE≥1 / REMOVED≥3 (history
  preserved); one source's absence cannot revoke a provider still observed
  by another; re-observation → REAPPEARED.
- Receipt validity: provider + model qualification receipts mint
  `material_fingerprint` = identity digest; `PROVIDER_RECEIPT_CURRENT` /
  `MODEL_RECEIPT_CURRENT` verify correspondence on authority-claiming
  states — identity drift invalidates routing, never deletes the receipt.
- Canonical routability is the ONLY runtime authority: unbound-router
  governed DSH dispatch throws `FAIL_CLOSED_DSH_MODEL_ROUTER_UNBOUND`
  unless `compatEnvRouteFallback` is explicitly declared (production MC
  never sets it); Planner lifecycle is independent of DSH executor
  registration (§13); bindings + router eligibility use authoritative
  `provider_id` (§9); `provider_id` claim conflicts record
  `contradictions[]`, never flip (§8).
- Secret governance: `sanitizeDiagnostic` on all probe/discovery error
  persistence; declared credential env values registered with the sanitizer
  at boot (§15). Single timeout authority `PAIR_MODEL_DISCOVERY_TIMEOUT_MS`
  (§14).
- Validation: focused 34/34 (A–K); full suite 2694 pass / 2 pre-existing
  env P5 fails (real dsh/codex on PATH, reproduced on base); tsc + build
  clean. Live E2E on scratch `PAIR_MC_DIR` with real credentials: full
  discover→validate→probe→qualify→reconcile→bind→routable chain, exact
  failing-gate observability (gemini route refused by
  CAPABILITY_TEXT_INFERENCE), `DISCOVERY_ELIGIBLE` provider non-routable
  with no receipt. IMPLEMENTED / PENDING INDEPENDENT AUDIT. See
  `PAIR_NEXT_PHASE_E_PROVIDER_MODEL_OPERATIONAL_CLOSURE_REPORT.md`.
- **R1 remediation** (same branch, pending re-audit): STALE providers are
  non-routable (`PROVIDER_CURRENT` gate); provider/model reappearance
  restores OBSERVATION only (REAPPEARED → `DISCOVERY_ELIGIBLE`/`DISCOVERED`
  + AUTH_REQUIRED/UNPROBED, re-qualification mints new authority);
  `MODEL_PROVIDER_MATCH` + `MODEL_PROVIDER_IDENTITY_CONSISTENT` linkage
  gates fail closed across planner/DSH/bindings
  (`FAIL_CLOSED_MODEL_PROVIDER_LINK_MISMATCH`); legacy fingerprint-less
  receipts no longer pass (`material_fingerprint` binds `provider_id`);
  source disappearance is explicit — never-configured skips silently,
  previously-active → ABSENT snapshot → bounded STALE→REMOVED (no
  indefinite last-known-good). Focused 45/45; full suite 2714 pass / same
  2 env P5 fails; tsc+build clean; live E2E boot chain intact.
- **R2 remediation** (same branch, pending re-audit): model/probe evidence
  is epoch-scoped — REAPPEARED resets `probe_state=UNPROBED`,
  `last_probe_at=null`, `current_qualification_receipt_id=null`,
  `probe_receipt_ids=[]` (historical receipt rows persist inspectable);
  `qualifyModel` reads `currentProbeReceipts()` only +
  `CURRENT_PROBE_EVIDENCE` gate; `issueQualificationReceipt` fails closed
  (`FAIL_CLOSED_MODEL_QUALIFICATION_EVIDENCE_MISSING`/`_FOREIGN`) — a
  caller can never mint QUALIFIED without current PASS probe receipts;
  provider `opts.probed` bypass removed (`PROTOCOL_PROBED` = durable
  `probe_state==="PROBED"` only); provider reappearance clears the
  current receipt pointer; configured route `P:M` must resolve to a model
  whose canonical `provider_id === P`
  (`FAIL_CLOSED_MODEL_ROLE_ROUTE_PROVIDER_MISMATCH`, before any
  role/candidate/invocation — planner and DSH share the seam);
  `providerRoutableGate` blocks STALE (agrees with `PROVIDER_CURRENT`).
  Focused 51/51; full suite 2720 pass / same 2 env P5 fails; tsc+build
  clean; live E2E confirms UNPROBED+receipt=null for enumeration-only
  providers.
- **R3 remediation** (same branch, pending re-audit): latest probe state
  governs invocation — new `MODEL_PROBE_CURRENT` gate (exact `PROBED`,
  availability-classified): a newer canonical probe FAILURE revokes new
  model invocation at planner + DSH before dispatch while history stays
  inspectable; `PROVIDER_PROBE_CURRENT` corrected to exact `PROBED`
  (UNPROBED no longer passes); `qualifyModel` `CURRENT_PROBE_EVIDENCE` =
  `probe_state==="PROBED"` (older PASS in window can't override latest
  FAIL); provider `issueQualificationReceipt` commit seam validates
  durable state itself (`AUTH_OK`+`PROBED`+no STALE/REMOVED, all-PASS
  gates → `FAIL_CLOSED_PROVIDER_QUALIFICATION_STATE`/`_GATES`);
  `currentProbeReceipts` verifies `model_entry_id` + provider ownership;
  model qualification `evidence_refs` derived internally from covering
  current PASS receipts. Focused 57/57; full suite 2726 pass / same 2
  env P5 fails; tsc+build clean.
- **R4 remediation** (same branch, pending re-audit): provider commit
  seam requires the canonical gate set
  `PROVIDER_QUALIFICATION_REQUIRED_GATES` (exported once) — every
  required gate must be present and `==="PASS"` (`gates:{}` and any
  missing/forged gate → `FAIL_CLOSED_PROVIDER_QUALIFICATION_GATES`);
  probe currentness is capability-scoped —
  `probeCurrentForCapability` evaluates the LATEST applicable receipt
  in window order per capability (new gate
  `MODEL_CAPABILITY_PROBE_CURRENT`), so a PASS for one capability
  never revives another; `evidence_refs` = latest covering receipt per
  capability; strict provider ownership — `recordProbeReceipt` throws
  `FAIL_CLOSED_PROBE_PROVIDER_MISMATCH` on wrong-provider rows and
  `currentProbeReceipts` excludes `provider_id: null`/foreign rows
  (inspectable history, never authority). Focused 62/62; full suite
  2731 pass / same 2 env P5 fails; tsc+build clean.
- **R5 remediation** (same branch, pending re-audit): canonical
  capability_scope contract — `normalizeCapabilityScope` requires a
  non-empty array of non-blank identifiers (trim + first-seen dedupe),
  enforced independently at `qualifyModel()` and the commit seam
  (`FAIL_CLOSED_MODEL_QUALIFICATION_SCOPE`); runtime gate
  `MODEL_QUALIFICATION_SCOPE_VALID` makes legacy empty/malformed-scope
  receipts non-routable (inspectable history; fresh probe +
  requalification recovers). Provider qualification decision is now
  canonical — `computeQualificationDecision` derives all five required
  gates from durable state + caller policy input; the commit seam no
  longer accepts caller-supplied `gates` (POLICY_PERMITS /
  HEALTH_ACCEPTABLE=PASS no longer forgeable); `qualify()` delegates
  to the same function; `PROVIDER_RECEIPT_CURRENT` requires the
  complete required gate set PASS inside the current receipt.
  Focused 69/69; full suite 2738 pass / same 2 env P5 fails;
  tsc+build clean.
- **R6 remediation** (same branch, pending re-audit): capability-scoped
  runtime authority — `MODEL_PROBE_CURRENT` (global `model.probe_state`
  summary) removed from `providerModelEligibility`; runtime authority
  = `MODEL_QUALIFIED` + `MODEL_RECEIPT_CURRENT` +
  `MODEL_QUALIFICATION_SCOPE_VALID` + `MODEL_CAPABILITY_PROBE_CURRENT`.
  `model.probe_state` remains observability/diagnostics only — an
  unrelated capability FAIL can no longer revoke a healthy qualified
  capability, and an unrelated PASS cannot revive a failed one.
  Focused 73/73; full suite 2742 pass / same 2 env P5 fails;
  tsc+build clean.

## Output language + delivery content authority (MERGED via PR #30 → `6ff9d35`)

- **Output-language contract**: canonical `output_language` stamp (digest-covered, plan-contract v2); output-scoped directive grammar; language verification gate before TDR mint; wrong-language output → deterministic UNDETERMINED, never sent.
- **Delivery content authority**: TEXT mode binds the exact validated payload into the TDR (text_sha256/text_length/text_source_artifact mandatory at projection — legacy "DONE" rows quarantined to FAILED_DELIVERY, zero network, no re-baseline); plan-contract v2 mandatory on every delivery plan (missing/forged marker → forced re-preview).
- **FILES = artifact transport**: dispatch pin + TDR slot sha256 mandatory; projection stages an immutable `.delivery-snapshots/<digest>` pin (fsync+rename+re-verify); snapshot-first retry authority (source drift/deletion cannot kill a retry; snapshot mismatch → reconstruct only from a sha-matching source, never re-baseline); transport reads the snapshot ONCE into a bounded buffer → hashes THAT buffer → `fileBytes` flows to the governed sender (Telegram uploader never re-reads the path — TOCTOU closed); `.txt`/`.md`/binary preserved byte-identical as documents; oversized → stat-first `FAIL_CLOSED_TELEGRAM_ARTIFACT_TOO_LARGE` (no unbounded read); orphan `.tmp` cleanup; exclusive begin, retry ceilings, UNKNOWN_SIDE_EFFECT preserved.
- Full report: `PAIR_NEXT_OUTPUT_LANGUAGE_DELIVERY_AUTHORITY_REPORT.md`.

## Phase F1 — Canonical Artifact Authority Foundation (branch `devin/1790985872-phase-f1-artifact-authority`, pending independent audit)

- **One artifact entity**: `artifact` rows under contract `pair-artifact.v1` — `artifact_id = ART_<digest(execution_id, logical_name)>` resolved wholly from durable producer state (execution → governed_task → mission/task); caller-supplied identity or sha256 is never authority; PAIR hashes independently.
- **Content-addressed byte store**: `<pair.db>/artifacts/blobs/<sha256>` — immutable, dedup by digest, tmp→fsync→rename→re-verify, orphan-tmp sweepable; canonical bytes live outside project workspaces (post-accept source mutation cannot touch them).
- **One ingest seam** `ArtifactAuthority.accept()/acceptBatch()`: durable identity/linkage proof → realpath containment (parent-symlink escapes fail closed) → stat-first 64MB bound → independent sha256 → exact-prior converge even post-close → lifecycle gate → atomic count+mint transaction (cap 32/execution enforced inside the txn — racing writers serialize). Batch mint is all-or-nothing; FAIL validation leaves zero new rows and `artifact_ids:[]`.
- **Local validator migrated**: `ArtifactProvenanceValidator` ingests through the seam; an artifact row now means "PAIR accepted and retained these exact bytes"; `execution_validation.artifact_ids` carries the canonical ids.
- **Remote ingest**: `acap1` execution-scoped capability (HMAC claims bound to mission/task/governed_task/execution/executor; master = `PAIR_ARTIFACT_UPLOAD_TOKEN || PAIR_BROKER_TOKEN`, never the outbox token remote sees); capability lane in `/api/outbox` → canonical ingest + outbox materialization (delivery compat preserved); legacy token lane is transport-compat only (`canonical:false` — cannot mint authority).
- **Read model**: `GET /api/artifacts[?mission_id]` / `/:id` → safe `pair-artifact://sha256/<sha>` refs, no host paths; pre-F1 path-only rows stay inspectable as `LEGACY_PATH_ONLY`, never promoted.
- **R1 closures**: HTTP wire bound per route (413 before materialization); capability claims cross-checked vs durable rows; outbox compat dest `${taskPrefix}-${artId}-${basename}` injective + unique tmp; response carries `pair-artifact://` refs only; CAS rename + parent-dir fsync.
- **R2 closures** (source-review re-audit): containment now bound to the EXACT opened object — `secureReadContained` (open once + `/proc/self/fd` realpath + fstat + bounded read on one fd; parent-symlink swaps post-open cannot redirect it); ONE byte realization — declared sha/size enforced inside the authority's single materialization (`FAIL_CLOSED_ARTIFACT_DECLARED_MISMATCH`), validator performs no independent read; replay requires a FULLY canonical prior (contract + every identity dimension + retained CAS bytes verifying to the digest); complete producer chain (`governed_task.executor_id == execution.executor_id == producer/capability`); writer+resolver share `compatOutboxBasename` (`a b.txt` resolves deterministically, collisions fail closed); dir-fsync fallback restricted to documented unsupported codes (EIO/unknown → `FAIL_CLOSED_ARTIFACT_BLOB_DURABILITY`); TRUE multi-process count-race proofs (31+2→32, 30+3→32, same-id convergence/conflict).
- **R3 closures** (source-review re-audit): `ensureBlobDirectoryDurable` is THE barrier — reused blobs re-prove dir fsync before a new mint (EIO retry cannot bypass); canonical prior must carry exact `storage.ref == blobs/<sha>` + regular-file CAS object (symlink/malformed → conflict); `secureReadContained` re-fstats the SAME fd post-read (dev/ino/size/mtimeNs/ctimeNs — mid-read growth/mutation → UNRESOLVED); multi-process race proof runs CURRENT SOURCE via tsx (`rm -rf dist` safe).
- **R4 closures** (source-review re-audit): `readCasBlob` is the ONE CAS read primitive — the fd proven regular IS the fd hashed (no lstat→reopen TOCTOU; CAS symlink never qualifies) for prior proof, blob reuse, post-rename verify; concurrency proof now uses a REAL READY+GO barrier inside each worker's own `store.immediate()` seam (no sleeps; `rm -rf dist` safe).
- **R5 closures** (source-review re-audit): worker artifact declarations are MANDATORY — every `result.artifacts` entry must carry `path` non-empty + `sha256` exactly 64-hex + `byte_size` finite integer ≥ 0 (absence = contract failure, never "PAIR computes it"); `Gate.collect_execution_result` enforces a strict result envelope — mission/task/governed/execution ids present AND equal to the durable row (`FAIL_CLOSED_RESULT_IDENTITY_MISSING|MISMATCH`), status in the terminal enum + array-typed artifacts (`FAIL_CLOSED_RESULT_ENVELOPE`); `ArtifactAuthority.verifyForExecution` re-proves EVERY ACCEPTED row at terminal validation — complete identity + storage contract + retained CAS bytes verified NOW via `readCasBlob` — a terminal PASS exposes `artifact_ids` only for bytes that verify; any malformed/unverifiable candidate fails the whole validation (`FAIL_CLOSED_ARTIFACT_VERIFICATION`), covering local mints and remote `artifacts:[]` uploads alike.
- **R6 closures** (source-review re-audit): `artifacts` is REQUIRED present AND an array in the result envelope (`FAIL_CLOSED_RESULT_ENVELOPE` — missing ≠ `[]`; result must be a non-null object); the validator defensively checks each entry — non-null/non-array object before any property read, `path` a non-empty string (no coercion), exact 64-hex `sha256`, finite integer `byte_size` — malformed entries FAIL, never an uncontrolled TypeError; `verifyForExecution` derives the expected artifact set from the append-only hash-verified `ARTIFACT_ACCEPTED` event plane (`metadata.execution_id`), not mutable rows — every historically-accepted id must still exist, remain fully canonical, and re-verify its CAS bytes NOW (disappearance / state flip / contract alter / execution move / deletion → `FAIL_CLOSED_ARTIFACT_VERIFICATION`), and any current row claiming the execution without acceptance history is rejected as injected authority (`no_acceptance_history`).
- **R7 closures** (source-review re-audit): the validator itself now requires `artifacts` to be an array (missing/null/object/string → FAIL; `[]` explicit); and each ARTIFACT_ACCEPTED event's recorded immutable facts (entity_id, logical_name, producer_executor_id, sha256, byte_size, channel) must still match the current row — a coherently rewritten row pointing at different valid CAS bytes FAILS on history, malformed acceptance metadata and conflicting duplicate acceptances fail closed. HEAD `8bff90c`.
- Remote-task DAG-leaf restriction UNCHANGED; F2/F3/P15 untouched. Full evidence: `PAIR_NEXT_PHASE_F1_CANONICAL_ARTIFACT_AUTHORITY_REPORT.md`.

## Phase F2 — Cross-Executor Canonical Artifact Handoff (branch `devin/1790999231-phase-f2-artifact-handoff`, pending independent audit)

- **`dependency_artifacts` (`pair-artifact-dependency.v1`)**: exact pins resolved BEFORE dispatch — artifact_id + producer task/governed/execution/executor + logical_name + sha256 + byte_size + deterministic `consumer_relative_path` (`.pair/dependency-artifacts/<ART>/<name>`) — stamped on the governed row (digest-covered) and pinned as durable `artifact_handoff` entities (`HOFF_<digest>`, PINNED|MATERIALIZED|FETCHED).
- **One `ArtifactDependencyResolver`**: consume edges (same `pair_dataflow` semantics, no second planner contract) → same-plan producer predecessor → latest COMPLETED execution → latest PASS validation → ART candidates must carry real `ARTIFACT_ACCEPTED` history AND pass `verifyArtifactForConsumption` NOW. Unbound/ambiguous → `FAIL_CLOSED_DEPENDENCY_RESOLUTION` → `DEPENDENCY_FAILURE` (zero dispatch, zero spend). Remote producer without canonical ART → fail closed; local without ART → legacy path edge stays outside the contract. Bounds: 32 deps/task, 256 MiB aggregate.
- **Local materialization**: `ArtifactHandoffService.materializeForConsumer` runs inside `dispatch_governed_task` BEFORE cost reserve + adapter dispatch — CAS bytes through `readForConsumption` → containment (workspace + allowed_paths + handoff-root) → symlink/different-bytes → FAIL, identical → converge → tmp+fsync+rename+dir-fsync + post-write `secureReadContained` + sha/size re-prove. Producer source paths never consulted.
- **Post-governance pin authority**: `assertContractUnmutated` at dispatch — entries↔handoffs must match field-by-field both directions; mutation/removal/injection → not dispatch-authorized.
- **Remote fetch**: `acread1` consume capability (distinct HMAC domain from `acap1`, same master env) binds mission/task/governed/execution/executor + dependency-set digest; `POST /api/artifacts/fetch` re-checks durable identity + live lifecycle (terminal/result → `consumer_closed`) + pinned membership + F1 retained-byte verification NOW → exact CAS bytes via octet-stream + `x-artifact-*` headers — never paths/listing/host paths. Idempotent re-fetch while live.
- **Remote DAG-leaf narrowing** (documented diff): remote tasks now carry dataflow names; a remote dep in `depends_on` MUST be bound by a resolved consume edge or `FAIL_CLOSED_PLAN_DATAFLOW_UNGOVERNED_REMOTE_EDGE`; sanitize mirrors it — declared-edge remote producer/consumer pairs now plan-legal, undeclared still fails closed.
- All F1 R1–R7 closures preserved; F3/P15 untouched. Full evidence: `PAIR_NEXT_PHASE_F2_CROSS_EXECUTOR_ARTIFACT_HANDOFF_REPORT.md`.
- **R1 remediation (pending re-audit)**: consumption consumes F1 history authority via shared `verifyAcceptedArtifact` + expected-binding `readForConsumption` (rewritten row/storage/CAS → reject; restart preserves); resolver requires the `RESULT_VALIDATED` event anchor for PASS (no event / wrong validation_id / wrong correlation / foreign scope → not consumable); materialization proves parent-symlink containment + re-verifies the pin before any byte lands; governed row + VALIDATED event carry `dependency_artifacts_digest` and approval scope binds to it (set-A approval never authorizes set B); `/api/artifacts/fetch` resolves ONE consume-master (artifact token → broker fallback, outbox token never, neither → disabled); remote fetch recipe = bounded `for i in 1 2 3 4 5` + mkdir + real `sha256sum`/`wc -c` verify + quarantine + `DEPENDENCY_FETCH_FAILED` STOP; R1.7 G = real `MissionRuntime` + real HTTP multi-process E2E (remote→local, remote-consumer fetch lifecycle w/ pre-exec 403 + retry, restart mid-DAG, remote non-leaf edge). 43 R1 tests; full suite 3047 pass / 2 env-only P5 fails. Classification: `PAIR_NEXT_PHASE_F2_CROSS_EXECUTOR_ARTIFACT_HANDOFF_R1_PENDING_SOURCE_REVIEW`.

## Not yet

- Workforce lifecycle beyond governed completion (Phase 4+), CEO
  agent / KPI gap analysis (P15/P16). Intentionally deferred.

## Release governance (current policy)

- **Independent source/code audit + required validation in the Devin/local
  environment is the release gate.** Required: typecheck, build, focused
  phase tests, full regression, concurrency/race tests where applicable,
  `pnpm audit --audit-level=high`, evidence integrity.
- **GitHub Actions is OPTIONAL** — never a release blocker. The CI workflow
  (`.github/workflows/ci.yml`) has no automatic trigger; it is runnable
  manually via `workflow_dispatch`. An Actions billing/account failure is an
  external state, not a code failure.
- Branch protection / GitHub Rulesets are **optional platform
  hardening** — not a release condition (the current private repo's
  plan does not enforce them). The canonical control is: dedicated
  branch + PR, required local validation, independent audit before
  merge, explicit manual merge only after audit pass. `main` is NOT
  currently protected; this file does not claim otherwise (see the
  P11 hardening report §10.14).
- **Phase F2 R2 (cross-executor artifact handoff, PR #32)**: remote consumers never fall back to local-path semantics (missing canonical ART + remote endpoint → `FAIL_CLOSED_DEPENDENCY_RESOLUTION`); resolver PASS filter binds the durable validation row exactly (validation_id + mission_id + governed_task_id + artifact_ids array + governed linkage); local materialization is fd-bound end to end (`O_DIRECTORY|O_NOFOLLOW` walk via `/proc/self/fd`, temp/rename inside the proven dir object — zero bytes can escape the workspace at any swap window); `/api/artifacts/fetch` uses only the injected consume master resolved once at bootstrap (`UPLOAD || BROKER`, ambient env never inspected, outbox never authority); the remote fetch recipe is shell-literal-safe and exits non-zero on failure (tmp-download → digest+size verify → atomic mv → quarantine + `exit 3`).
- **Phase F2 R3 (cross-executor artifact handoff, PR #32)**: dependency destinations are consumer-isolated — `consumer_relative_path` = `.pair/dependency-artifacts/CT_<consumer-task-digest>/<ART>/<name>` derived from canonical consumer task identity, recomputed and exact-matched at every authority boundary (gate / approval digest / pin / materialize / remote fetch / unmutated-contract check), so a forged under-root path or another consumer's path can never serve. Final publication is atomic NO-REPLACE: `linkSync` inside the pinned parent-dir object — EEXIST → exact pinned bytes converge (idempotent, no rewrite), different bytes fail closed leaving the existing object untouched, symlinks fail closed; temp cleaned on every handled path. Remote recipe publishes with `ln` no-clobber + dep_ok converge-first semantics (no `mv -f`, no `rm` of the target).
- **Phase F2 R4 (cross-executor artifact handoff, PR #32)**: the remote fetch recipe no longer `exit 0`s on success — a composed multi-artifact preparation (`buildDependencyFetchPreparation`, the exact block embedded in Devin prompts) falls through per artifact so ALL pinned dependencies are prepared before task work; failure still exits non-zero and stops preparation. Temp hardlinks are cleaned on every success/converge path; existing-exact converge creates no temp; failures keep quarantine + `exit 3`.

- **Phase F3 (planner + recovery artifact/dataflow closure, branch `devin/1791012206-phase-f3-replan-closure`, pending audit)**: one authority module `plan-feasibility.ts` — `pair-plan-semantic.v1` digest over execution-meaning fields (instruction, sorted caps, position-ordered depends_on, produces/consumes, conditional contracts, planner pin — no mutable identity); `analyzePlanFeasibility` runs inside `commitPlan` as the commit-boundary re-proof (`FAIL_CLOSED_PLAN_FEASIBILITY` + typed `dependency_reason`) on every path; `pair-recovery-failure-context.v1` persists bounded typed context on pending_recovery + recovery decisions with a restart-stable `::rc_` signature suffix; `pair-replan-attempt.v1` ledger gives bounded deterministic attempt slots (`MAX_REPLAN_CANDIDATES_PER_DECISION=2`) — `runReplan` is now a candidate loop (validate → dataflow → digest → ledger-before-mutation → accept commit); identical semantic replans are `REJECTED_DUPLICATE` before any old-plan mutation (zero remote spend, zero revision), rejection digests feed the next candidate via planner `replan_context`, and exhaustion records `FAIL_CLOSED_REPLAN_CANDIDATES_EXHAUSTED` → fresh RecoveryController decision (ABORT for DEPENDENCY_FAILURE). Full evidence: `PAIR_NEXT_PHASE_F3_PLANNER_RECOVERY_ARTIFACT_DATAFLOW_CLOSURE_REPORT.md`.
- **Phase F3 R1 (PR #33, pending audit)**: (a) `src/pair/serve-planner.ts` owns the serve planner composition — REPLAN path calls a configured synchronous `replanProvider` with the full `replan_context` and canonicalizes through the same seam as initial plans (`FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE`/`_INFEASIBLE` otherwise — never replays the pinned plan; prod wires null → REPLAN deterministically fails closed to the next matrix action); (b) `selected_executor` removed from `canonicalPlanSemanticDigest` + the commitPlan freeze — routing pins are post-commit evidence, not plan semantics, so a pre-F3 plan digests identically before/after routing and restart; (c) replan commit is crash-safe — `replan_attempt` PREPARED rows durably bind the exact validated candidate (prepared_tasks/proposal/superseded_plan_id) before any mutation, commitCandidate runs inside ONE `store.immediate` atomic region {commit/receipt-bind + markCommitted + old-plan cancel/supersede + recovery clear + READY}, restart resume re-commits the SAME prepared candidate with zero planner calls, receipt binding excludes the superseded plan_id (semantic-restore shares the failed digest), and markCommitted is a closed PREPARED→ACCEPTED state machine with full immutable-fact replay checking (`FAIL_CLOSED_REPLAN_ATTEMPT_SLOT_CONFLICT/_MISSING/_STATE`). **R2 (PR #33, pending audit)**: commit receipts are attempt-bound, never digest-only — `mission_plan_revision.replan_commit` (`pair-replan-commit.v1`: recovery_id + replan_attempt_id + superseded_plan_id) written by `commitPlan({replan_commit})`; receipt discovery requires exact binding + mission + semantic digest match (the historical digest scan is removed — a same-digest older revision can no longer be adopted as a commit it never made); ACCEPTED receipts are re-verified against the bound revision (`FAIL_CLOSED_REPLAN_COMMIT_RECEIPT`); commitPlan returns the persisted semantic digest re-proven equal to the prepared candidate (`FAIL_CLOSED_REPLAN_COMMIT_DIGEST`); markCommitted binds plan_id+revision+digest and requires receipt digest == candidate digest; the attempt row is re-read inside `store.immediate` so concurrent resume converges on the existing ACCEPTED receipt with zero new revisions. **R3 (PR #33, pending audit)**: `assertReplanCommitReceipt` independently re-proves the receipt itself — a THREE-WAY digest identity (attempt.candidate == receipt.plan_semantic_digest == revision.plan_semantic_digest) plus exact plan_id+revision and attempt binding; a canonically-rewritten receipt digest on an ACCEPTED row now fails closed on resume (`FAIL_CLOSED_REPLAN_COMMIT_RECEIPT`).

- **P14 WFV2 Phase 2 R2 (collaboration provenance completeness)**: missing `workforce_message_receipt` now fails closed everywhere — `assertCanonicalCollaborationBundle` derives `WIR_<mid>_<recip>` from the canonical message and requires the exact validated receipt; `inboxForAgent`/`listWorkItemMessages` return only the `CORRUPT` projection (no body, never synthesized `PENDING`); `reconcileWorkGraph` detects missing/corrupt receipts and appends one deterministic `WORK_COORDINATION_CORRUPT` per message (idempotent, never fabricates); ACK event must pin `message_id`+`recipient_agent_id`+`acknowledged_at`. `P14-P2-R1-ASSIGN-CLAIM-RACE-INVERSE` is now a genuine 2-worker race (assign vs in-txn heartbeat); added `CLAIM-PROJECT-REVOKE` race. Focused 55/55; live E2E verified delete→CORRUPT→restart→1 corrupt event, receipt never recreated.

- **Phase F4 + F4 R1 + F4 R2 + F4 R3 + F4 R4 + F4 R5 (delivery artifact provenance + final send-gate + transactional lifecycle closure, branch `devin/1791021130-phase-f4-delivery-provenance`, pending audit)**: the shared `outbox/` is transport/storage only — never authority. Every FILES-mode manifest artifact must bind a canonical in-mission artifact: declared produce edge + COMPLETED + anchored execution_validation PASS + ARTIFACT_ACCEPTED + same mission_id + same plan_revision, re-verified through `ArtifactAuthority`/`verifyAcceptedArtifact`/`readForConsumption`. Pin carries `{artifact_id, producer_execution_id, logical_name, sha256}`; settle re-verifies CAS bytes. Plan-dataflow remote-predecessor inference deleted — producerless manifest artifacts are `FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT` at commit. TEXT binds `outbox/report.txt` to the current delivery execution's canonical artifact or an earlier declared in-mission producer. **R1:** pin misses are typed `DependencyResolutionError` → governed `DEPENDENCY_FAILURE` recovery — no exception escapes the tick. TDRs carry `DeliveryProvenanceBinding` + immutable `TELEGRAM_DELIVERY_MINTED` receipt; projection requires exactly one receipt + live `verifyArtifactForConsumption`. >1 canonical identity → `ambiguous_delivery_artifact` fail-closed. **R2:** receipt existence owns the authority path — deleting provenance fields can never downgrade to legacy; `wholeContractValid` binds mode + `delivery_id === entity_id` + EXACTLY ONE receipt + bijective slot↔receipt match (no extra/missing/renamed/duplicate slot); mint receipt + TDR row commit in ONE `store.immediate` transaction with in-transaction idempotent re-check; restart proof rebuilds the entire stack (fresh store/service/scheduler/approvals/recovery/runtime/control) on the reopened DB. **R3:** the mint receipt binds the COMPLETE static send authority (entity/mission/task/execution/mode/destination{provider,chat_id,provenance}/sendability/max_attempts/outbox_dir/workspace/per-slot source_path+ceiling) — any coherent static rewrite is fail-closed; snapshot storage moved to canonical store-scoped `deliverySnapshotRoot` (`store.dbDir/.delivery-snapshots`, entity_id-keyed) with ZERO fs ops before contract validation; append-only `TELEGRAM_DELIVERY_ATTEMPT_STARTED/RESOLVED` evidence is the lifecycle high-water authority committed atomically with each projection — a mutable rollback mints no new send permission (`FAIL_CLOSED_TELEGRAM_DELIVERY_LIFECYCLE`); retry consumption derives from the immutable ledger, not the mutable counter. **R4:** BEGIN itself is the final immutable gate — inside one `store.immediate` it re-proves the canonical row, the complete mint-receipt static contract, the slot's live artifact authority, and a *sequence-validated* lifecycle ledger (per-slot STARTED/RESOLVED pairing, deterministic `ATT_<digest(entity:slot:n)>` ids, n++ numbering, terminal SENT/UNKNOWN never re-acquiring) — before minting STARTED+SENDING. RESOLVE requires exactly one unresolved STARTED whose attempt_id+attempt_number match the mutable SENDING identity; stale reconcile requires the same exact STARTED after the same static-contract verifier — forged SENDING is quarantined with ZERO lifecycle evidence. Receipt-bound ceilings can never be widened by mutable fields; the pending pass quarantines any bound row whose immutable contract fails before any evidence mutation. One canonical verifier (`deliveryStaticAuthority`/`deliveryWholeContractValid`/`deliverySlotLifecycleViolation`/`deliveryOpenStarted`/`deliveryEffectiveCeiling`) serves pending, begin, resolve and reconcile identically. **R5:** stale reconcile now performs every authority-relevant check — canonical reload, static contract, ledger rebuild/validation, exact STARTED identity, stale re-check, UNKNOWN evidence append, projection write — inside ONE `store.immediate` per candidate (the outer list is discovery-only; a competing writer cannot mint an incorrect UNKNOWN and a mid-transaction fault rolls back both writes). The lifecycle ledger is budget-aware — a STARTED beyond the immutable mint ceiling (`started_over_ceiling`) and a SENT resolve without a valid positive-safe-integer `message_id` (`sent_invalid_message_id`) both make the history INVALID at every seam. Full evidence: `PAIR_NEXT_PHASE_F4_DELIVERY_ARTIFACT_PROVENANCE_REPORT.md`.

- **Phase F5 (remote producer canonical artifact closure, branch `devin/17591791034026-phase-f5-remote-producer-closure`, pending audit)**: declared `metadata.pair_dataflow.produces` on a REMOTE-capability task is pinned at request build into `expected_output_contract.declared_produces` — normalized (trim/dedupe/sort), bounded (≤32), digest-covered by the existing governed approval scope, immutable after dispatch. Devin prompts enumerate every declared name with a mandatory acap1 `/api/outbox` upload-before-completion instruction (no master secrets, no second mechanism). Terminal validation adds the ONE closure gate: remote executions with a declared-produces array must show exactly one accepted, independently re-verified canonical artifact per declared name for THIS execution before PASS — missing → `FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:<name>` + bounded evidence (`remote_produces_missing` + `declared_produces_digest`); a recomputed scope-digest mismatch is `FAIL_CLOSED_GOVERNED_SCOPE_MUTATED:expected_output_contract`. settleExecution routes it to DEPENDENCY_FAILURE on the producer task (`REMOTE_PRODUCER_ARTIFACT_MISSING`). Structural lane feasibility is checked at governed request construction (pre-remote-spend boundary — executor selection is post-commit by design): `PAIR_OUTBOX_URL` + resolvable upload master or `FAIL_CLOSED_REMOTE_INGEST_LANE_UNAVAILABLE`, zero dispatch. Live repro `MSN_01M410PK2CPSHNNDB7PM85TTRR` (the incident shape that aborted pre-F5): DEVIN uploaded `data.json` via acap1 → `ART_4FF8194CD2F7D5D0B07B4ED453EA3F20`, PASS row binds artifact_id + declared digest, T3 pinned the exact artifact, T4 Telegram SENT, mission COMPLETED. **F5 R1 (PR #36, pending audit)**: the F5 binding now derives from the IMMUTABLE mint-time `GOVERNED_TASK_VALIDATED` anchor, never from the current shape of a mutable governed field — the anchor (event + evidence) immutably binds `governed_task_id`, `mission_id`, `task_id`, `executor_id`, `plan_id`/`plan_revision`, `approval_scope_digest`, `remote_produces_contract` (isRemoteCapabilityTask at mint), the normalized `declared_produces` set and `declared_produces_digest`. Terminal validation on a remote-capable execution resolves exactly ONE anchor (missing → `FAIL_CLOSED_GOVERNED_MINT_ANCHOR:MISSING`, duplicate → `:AMBIGUOUS`), proves identity correspondence (`:IDENTITY`), recomputes the CURRENT scope and compares it against the ANCHOR's immutable `approval_scope_digest` (a coherent self-consistent rewrite of the mutable row's own digest now fails), proves the current declared set digest-equals the mint set, and only then runs canonical closure. `remote_produces_contract: true` on the anchor makes the F5 contract required forever — deletion, null/malformed reshape, narrowing, widening, reorder, coherent digest rewrite, or anchor deletion can never downgrade an F5-minted execution to legacy; a genuine pre-F5 anchor (marker field absent) preserves documented legacy semantics, so legacy classification derives only from immutable provenance. **F5 R2 (PR #36, pending audit)**: F5 applicability now resolves ONLY through the immutable authority chain `execution → governed_task → exactly-one mint anchor → anchor.remote_produces_contract` — the current task row is never consulted for applicability, so post-dispatch capability rewrites or task deletion can never downgrade an F5-minted execution (ONCE F5-BOUND, ALWAYS F5-BOUND). F5-era anchors must bind the complete pinned identity (governed/mission/task/executor/plan_id/plan_revision three-way → `MINT_ANCHOR:IDENTITY`); malformed markers → `:MARKER`; an F5 anchor must self-validate its own declared_produces under the mint normalization contract + digest equality → `:DECLARED_PRODUCES`; genuine pre-F5 anchors (marker absent) preserve documented legacy semantics. Full evidence: `PAIR_NEXT_PHASE_F5_REMOTE_PRODUCER_ARTIFACT_CLOSURE_REPORT.md`.

- **Incident ACR-1 (capability-reject durable evidence, branch `devin/1791064626-acr1-capability-reject-evidence`, pending audit)**: every `acceptArtifactUpload` capability reject — `signature`, `durable_identity`, `mission_id`, `task_id` — now emits exactly one append-only `ARTIFACT_CAPABILITY_REJECTED` event per DISTINCT received capability value (deterministic `ACR_<sha256[:16]>` entity id dedupes replays; the events-hash integrity check covers it). Persisted fields are bounded and secret-free: stage + `capability_sha256` of the RECEIVED value + filename + claimed mission/task/execution identity (verified claims first, else request body). Raw capability, auth header, body bytes, and master secret are never persisted; the audit write is failure-isolated so it can never alter the fail-closed rejection (same `PolicyError`, same stage codes). Closes the incident gap where a remote worker's "capability rejected" claim left zero durable evidence of what was actually sent. Full evidence: `PAIR_NEXT_INCIDENT_ACR1_CAPABILITY_REJECT_EVIDENCE_REPORT.md`.

- **Incident DSN-1 + R1 (consume-name spelling normalization, branch `devin/1791275412-dsn1-consume-name-normalization`, pending audit)**: `prerequisiteMissing()` now judges canonical resolution through the ONE shared spelling rule — `artifactNamesEquivalent` in `artifact-authority.ts` (pairwise-direct: `na===nb`, or ONE side is `outbox/<basename>` of the OTHER — never transitive basename equivalence, so `dirA/X` ≢ `dirB/X`) — instead of raw string equality, and the resolved set covers BOTH canonical lanes: `dependency_artifacts[].logical_name` (handoff) ∪ the `PINNED` entries of `pair_delivery_artifact_digests` (delivery provenance pin, re-read from the durable row). `resolveForConsumer` and `resolveDeliveryArtifact` match producers through the same equivalence (superset: producer `outbox/X` ↔ consume `X` and producer `X` ↔ consume `outbox/X` both bind); equivalent spellings bound to DISTINCT canonical artifacts still fail closed ambiguous (`ambiguous_dependency_artifact` / `ambiguous_delivery_artifact`), and unresolved consumes keep the exact legacy `missingConsumedArtifact` → `FAIL_CLOSED_LOCAL_PREREQUISITE_MISSING` path. Closes MSN_01M420PJ (remote `outbox/chart.png` produce vs `chart.png` manifest consume → dependency failure with all artifacts legitimately pinned). **R1:** equivalence narrowed from spelling-set intersection (which made any two same-basename non-outbox paths equivalent via a shared generated `outbox/<basename>` alias) to the mandated pairwise rule — `reports/internal/report.md` ≢ `reports/customer/report.md`; adversarial proofs on the resolver lane (unbound → `FAIL_CLOSED_DEPENDENCY_RESOLUTION`), the delivery lane (pin mint → `FAIL_CLOSED_DELIVERY_ARTIFACT_PROVENANCE`), and the prereq lane (unrelated resolved name cannot exempt a same-basename consume — legacy check still reports it). Full evidence: `PAIR_NEXT_INCIDENT_DSN1_CONSUME_NAME_NORMALIZATION_REPORT.md`.

- **CNI-1 (CODEX ambient unrestricted internet access — Option B+, branch `devin/1791076891-cni1-codex-ambient-internet`, pending audit)**: CODEX dispatch network authority is now a server-level env switch `PAIR_CODEX_NETWORK`, resolved per dispatch through the `envReader` seam (never cached, never propagated to the child env) — truthy `on|true|1` (trim + case-insensitive) → ON; everything else (unset/empty/off/false/yes/enabled/2/garbage) → OFF, identical to pre-CNI-1 argv. One resolved `netAllowed` drives BOTH `permissions.<profile>.network.enabled` (both `pair_read` and `pair_workspace`) and `web_search=live|disabled` — never split state; per-dispatch `CODEX_NETWORK: on|off` log line; prod default ON via `PAIR_CODEX_NETWORK="${PAIR_CODEX_NETWORK:-on}"` in `start-pair-live.sh` with operator override honored. Live smoke caught and fixed the upstream `web_search` enum contract (`enabled` is invalid → `live` for ON). No new permission/gate/planner/router/recovery changes; `argv_sha256` in `execution_journal.json` remains the argv evidence and ON/OFF digests differ by exactly the two net literals. Smoke on a scratch prod-shape stack (real codex, real CODEX_HOME): ON → `MSN_01M42AGWE5RH3AJT7RDH2RQZRN` COMPLETED, T2 routed CODEX, real timeapi.io fetch → `net_probe.txt` accepted through the canonical artifact lane (`ARTIFACT_ACCEPTED`, `sha256=daa7d4054d…`); OFF → `MSN_01M42AX7NM645FD29E06KAACXM` CODEX sandbox denied egress (DNS resolution failure), no file. Classification: `PAIR_NEXT_CNI1_CODEX_AMBIENT_INTERNET_ACCESS_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_CNI1_CODEX_AMBIENT_INTERNET_ACCESS_REPORT.md`.

- **CPL-1 (Codex GPT-6.1 Sol planner primary, branch `devin/1791091651-cpl1-codex-sol-planner`, pending audit)**: `codex-cli:gpt-6.1-sol` is planner route #1 via a dedicated `CodexPlannerProvider` transport (`src/pair/codex-planner.ts`, `transport:"codex_cli"`) — explicitly NOT `CodexCliExecutorAdapter` (no dispatch/governed lane/executor artifacts; planner child runs `codex exec` under a read-only network-disabled `pair_planner` permission profile with strict structured output `--output-schema`/`--output-last-message` + stdin prompt). The single failover authority is unchanged: `beginPlannerRun → candidate → assertEligible → invoke → canonicalizeLlmTasks → validatePlanProposal → SUCCESS/FAILED → next`, output entering the same sanitize/canonicalize path (malformed/degenerate → typed FAILED → next; no template fallback). `ensureCodexCliPlannerCatalog` seeds a real catalog provider+model so strict route resolution, `PLANNER_COORDINATOR` role, planner∩DSH disjointness and `model_entry_id` binding hold; boot runs a REAL schema-constrained probe through `validateAccess`/`probeModel`/`qualifyModel`, and the candidate is retained unconditionally so failed probes still yield typed per-attempt eligibility evidence (CLI_MISSING/AUTH_REJECTED/MODEL_UNAVAILABLE/TIMEOUT/QUOTA_RATE_LIMITED/PROVIDER_UNAVAILABLE) while authority violations (role/DSH-overlap/REMOVED-etc.) keep throw semantics. Default order `codex-cli:gpt-6.1-sol` → `gemini:gemini-3.1-flash-lite` → extras with full env override (`PAIR_PLANNER_MODEL_ROUTE`/`_FALLBACK_ROUTE`/`_EXTRA_ROUTES`; api-only lists keep codex out — test J). New env `PAIR_CODEX_PLANNER_TIMEOUT_MS` (5s–900s, default 900s = 15min as of R1), `PAIR_CODEX_PLANNER_EXECUTABLE` override. Focused suite 11/11 (A–J + probe); regressions 278+402 green; full suite 3348 pass / 2 known env-only P5 fails; tsc + clean build + audit(0 high) green. Live smoke on scratch stack, real codex auth: boot `MODEL_ROUTE: codex-cli:gpt-6.1-sol QUALIFIED (probe PASS)`; `/api/missions/preview` → `planner_attempt PA_01M42QXVGBYHT5Z9E66PWPY3QY` SUCCESS (18.5s), `planner_run …PRN_01M42QXVGA508D2GVGB250BNRN` WINNER_SELECTED winner_attempt_no=1, preview READY `plan_model: gpt-6.1-sol`. Classification: `PAIR_NEXT_CPL1_CODEX_SOL_PLANNER_PRIMARY_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_CPL1_CODEX_SOL_PLANNER_PRIMARY_REPORT.md`.
- **CPL-1 R1 (canonical eligibility + auth isolation + timeout authority remediation, same branch `devin/1791091651-cpl1-codex-sol-planner` / PR #40, pending audit)**: `assertCodexPlannerCandidateEligible` is now a thin wrapper over the same canonical seam every candidate uses — `assertPlannerCandidateEligible` (role + planner∩DSH disjointness + `providerModelEligibility`, all 16 gates authoritative verbatim) — with codex-typed `failure_class` enrichment on the availability channel only; AUTHORITY_GATES throws propagate untouched. Codex-first bounded canonical refresh (mandate §3): availability-channel rejections earn exactly ONE refresh — `refreshCodexPlannerQualification` re-runs the real boot seams (`validateAccess(probe=codexPlannerProbe)` → `qualify` → `setLifecycle(QUALIFIED)` → `probeModel` → `qualifyModel`) then FULL eligibility is re-proved; PASS keeps codex #1, still-fail settles typed FAILED + `refresh_failed:<gates>` and Gemini proceeds. Authority throws are never refreshed (DISABLED/BLOCKED/REMOVED, UNQUALIFIED, receipt-fingerprint invalid, ownership mismatch, provider_id contradiction, role/DSH-overlap) — zero invocation, `AUTHORITY_REJECTED` evidence; a refresh-derived UNQUALIFIED stamp (failed requalification) settles FAILED→Gemini while fresh DISABLED/REMOVED marks or receipt/identity violations still abort. Auth isolation (R1.B): `CODEX_API_KEY`/`OPENAI_API_KEY` removed from the planner child env whitelist (PATH/HOME/LANG/LC_ALL/CODEX_HOME/NODE_PATH + test-only FAKE_CODEX_* remain). Timeouts (R1.C/§9-10): `PAIR_MODEL_PROBE_TIMEOUT_MS` default `60000` authoritative verbatim (60s Math.max floor removed); `PAIR_CODEX_PLANNER_TIMEOUT_MS` default `900000` (15min) — independent budgets, no cross-coupling; sleeping probe dies at the configured budget. Evidence hygiene (R1.E): no codex account identifiers persisted in the report. Focused suite 27/27 (A–J + probe + §4 adversarial matrix + env isolation + timeout authority); full suite 3363 pass / 2 known env-only P5 fails; tsc + `rm -rf dist` build + audit(0 high) green. Classification: `PAIR_NEXT_CPL1_CODEX_SOL_PLANNER_PRIMARY_R1_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_CPL1_CODEX_SOL_PLANNER_PRIMARY_REPORT.md`.
- **CPL-1 R2 (production probe default + actual provider-STALE canonical recovery, same branch / PR #40, pending audit)**: `scripts/start-pair-live.sh` now passes `PAIR_MODEL_PROBE_TIMEOUT_MS:-60000` (was forcing 30000 over the canonical env default; explicit env still wins verbatim, no hidden floor — regression test pins the line). `refreshCodexPlannerQualification` begins with a canonical re-observation step: a STALE provider (and never REMOVED/DISABLED — upfront authority throws) is re-observed through `ProviderCatalog.upsertCandidate` with the identical configured codex-cli identity shared with `ensureCodexCliPlannerCatalog`, clearing STALE→REAPPEARED and demoting stale authority before the normal validateAccess→qualify→probeModel→qualifyModel chain re-mints it — no direct condition mutation, no shadow currentness flag. Focused suite 31/31 (R2.A script default, R2.B1 STALE→recover→codex#1, R2.B2 STALE+dead-probe→gemini, R2.B3 REMOVED→authority throw ZERO refresh/invocation + retained R1 structural cases). Classification: `PAIR_NEXT_CPL1_CODEX_SOL_PLANNER_PRIMARY_R2_PENDING_AUDIT`.
- **CPL-1 R3 (structural pre-probe guard + deterministic probe-timeout test, same branch / PR #40, pending audit)**: `refreshCodexPlannerQualification` (the shared boot+pool qualification seam) now opens with a structural guard on a fresh canonical read — provider DISABLED/REMOVED/UNQUALIFIED and model REMOVED/DEPRECATED/BLOCKED / planner↔DSH-overlap / role violations throw `FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE`/model-role IntegrityErrors BEFORE any `codexPlannerProbe`, closing the boot path gap and the plan-time TOCTOU where a mark lands after the availability verdict. Recoverable evidence (STALE → R2 re-observation, PROBE_TIMEOUT → bounded re-probe) still reaches the probe; bootstrap discovery state is unaffected (R3.A7). §10 test now drives the fake executable through the production `PAIR_CODEX_PLANNER_EXECUTABLE` env seam with ledger/pidfile/killed-child proof. Focused suite 38/38; full suite 3375 pass / 2 known env-only P5 fails. Classification: `PAIR_NEXT_CPL1_CODEX_SOL_PLANNER_PRIMARY_R3_PENDING_AUDIT`.
- **CPL-1 R4 (transient UNQUALIFIED recovery + pre-probe linkage authority, same branch / PR #40, pending audit)**: `UNQUALIFIED` removed from the R3 structural pre-probe set — it is Phase E transient residue the canonical qualify chain legitimately clears (restart regression proves: failed boot stamps it, second boot recovers to QUALIFIED/AUTH_OK/PROBED with a fresh receipt). Guard now also checks `MODEL_PROVIDER_MATCH` + `MODEL_PROVIDER_IDENTITY_CONSISTENT` via the shared `providerModelEligibility()` projection before any `codexPlannerProbe` (boot path + plan-time TOCTOU both covered; only these two structural gates are pre-probe — bootstrap intentionally lacks the qualification gates). `assertPlannerCandidateEligible` plan-time semantics unchanged. Focused 43/43; full suite 3380 pass / 2 known env-only P5 fails. Classification: `PAIR_NEXT_CPL1_CODEX_SOL_PLANNER_PRIMARY_R4_PENDING_AUDIT`.
- **CPL-1 R5 (operational codex unavailability → typed attempt → gemini #2, same branch / PR #40, pending final audit)**: `assertCodexPlannerCandidateEligible` now converts a `FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE` throw into a failover-eligible typed rejection ONLY when every failed authority gate is provider-operational ({QUALIFIED, AUTH_OK, NOT_BLOCKED}), no DISABLED/REMOVED condition exists, and durable probe_state/auth_state proves a recognized operational failure (CLI_MISSING/TIMEOUT/RATE_LIMITED/MODEL_UNAVAILABLE/AUTH_FAILED/CREDENTIAL_MISSING/UNREACHABLE → existing PLANNER_FAILURE_CLASS vocabulary). UNQUALIFIED alone still throws; receipt/linkage/role/overlap violations still throw; `assertPlannerCandidateEligible` unchanged. Test B replaced (boot CLI_MISSING→FAILED→gemini#2); R5.A2–A5 boot-shaped AUTH_FAILED/MODEL_UNAVAILABLE/TIMEOUT/RATE_LIMITED→gemini#2; R5.A6 recovery regression (requalification→codex#1); R5.A7 UNQUALIFIED-alone→throw. Focused 49/49; full suite 3386 pass / 2 known env-only P5 fails. Classification: `PAIR_NEXT_CPL1_CODEX_SOL_PLANNER_PRIMARY_R5_PENDING_FINAL_AUDIT`.
- **PRV2-A (planner capability modernization, branch `devin/1791105961-prv2a-planner-modernization`, pending audit)**: planner prompt no longer forces remote for internet/software/visual work — it requests the minimum capability set (network-sufficient / CODE_GENERATION·CODE_EDITING·SHELL_EXECUTION·PYTHON_EXECUTION·FILE_OPERATIONS / local-chart→PYTHON_EXECUTION·screenshot→network-capable·image→governed-only) and the Mission Router chooses the executor. Model emits WORK tasks only (`NEVER AUTOMATON_TASK_EXECUTION`): PAIR injects the single canonical T1 bookkeeping task at `makeServeCanonicalizer` via `canonicalBookkeepingTask(goal)` (same existing worker_spec contract, goal as payload — Telegram intent cannot leak into the instruction); model-emitted bookkeeping-shaped tasks (filtered caps ⊆ {AUTOMATON}) are deterministically dropped with their deps repointed to T1; work keys remap to T2..T(n+1). Adaptive work-task budget replaces the flat 5: `score = words + 4*enumerations + 2*connectives` → ≤40 budget 4 / ≤120 budget 6 / else 10, absolute ceiling 12, bookkeeping never counted, configured cap only tightens; prompt carries the 5 anti-over-planning split reasons. All governance preserved verbatim (validatePlanProposal, DAG, capability allowlist, joint-servability, artifact/dataflow reconcile, telegram intent + R8 invariant + delivery-verb scan, output language, reserved metadata, delivery manifest, handoff, eligibility, CPL-1 failover, role separation, codex network-disabled profile, Router/Gate/artifact/credential authority). Residual: codex `PLAN_SCHEMA` still cannot emit declared edge fields (recorded, not widened). Focused 17/17; F3-R1 regression 20/20 (fixtures updated: canonical pinned plans + real PAIR_NATIVE harness + async drive); full suite 3403 pass / 2 known env-only P5 fails; tsc + `rm -rf dist` build + audit(0 high) green. Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_REPORT.md`.
- **PRV2-A R1 (reserved AUTOMATON + real NETWORK_ACCESS, same branch `devin/1791105961-prv2a-planner-modernization` / PR #41, pending audit)**: R1.A — model-visible planner vocabulary is now `SERVE_LLM_WORK_CAPS` (canonical caps minus `AUTOMATON_TASK_EXECUTION`); `buildPlannerUserPrompt`'s ALLOWED_CAPABILITIES can never show it. `reservedAutomatonMisuseKey(rawTasks)` rejects on the RAW emission before sanitize: a task carrying AUTOMATON that is not pure-bookkeeping-shaped (mixed `[AUTOMATON, X]` or pure-with-foreign-worker_spec) dies as typed evidence — planner layer returns `{tasks:[], warnings:[LLM_PLAN_RESERVED_CAPABILITY_AUTOMATON:<key>]}` (failover-eligible), canonicalizer throws `FAIL_CLOSED_PLAN_RESERVED_CAPABILITY_AUTOMATON_TASK_EXECUTION` (FAILED/CANONICAL_VALIDATION_FAILED attempt → next candidate). Never stripped-and-pretended, never a second bookkeeping worker_spec; pure bookkeeping emissions still normalize (dep→T1 remap preserved via internal `sanitizeCaps` shape-passthrough, never model-visible). Final-plan invariant: exactly one AUTOMATON task = T1 = `canonicalBookkeepingTask(goal)`. R1.B — `NETWORK_ACCESS` is a registered capability (SERVE caps + `registerCapability`): Devin claims it statically (governed ambient net), Codex claims it LIVE per `codexNetworkAllowed()` (CNI-1 `PAIR_CODEX_NETWORK` per-call env read); CapabilityRouter DISPATCH step 5b re-proves the adapter's current `capabilities()` for NETWORK tasks → `MISSING_LIVE_CAPABILITIES:NETWORK_ACCESS` when a stale registration claims it; DSH never network-eligible via REASONING/SHELL (cap list unchanged). No REASONING/PYTHON proxies; planner prompt requires NETWORK_ACCESS on current/external-data tasks as a routing fact, never names an executor. Residual: boot-OFF→flip-ON Codex needs re-registration (fail-closed asymmetry, documented). Focused 33/33 (17 base + 16 R1); regression: llm-planner 16, CPL-1 49, CNI-1 22, dataflow-incident 106, ops-telegram 3, F3×4 72, p4/p7/p8 81 all PASS; full suite 3419 pass / 2 known env-only P5 fails; tsc + `rm -rf dist` build + audit (0 high) green. Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R1_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_REPORT.md`.
- **PRV2-A R2 (deterministic network-requirement canonical gate, same branch `devin/1791105961-prv2a-planner-modernization` / PR #41, pending audit)**: the current/external-data → `NETWORK_ACCESS` requirement is now enforced canonically, not by prompt. One conservative detector in `llm-planner.ts` (bounded EN+VI keyword regexes): `goalRequiresCurrentExternalData` = currency-marker AND (fetch-verb OR data-object OR online-marker) — "price"/"analysis" alone never fires, "web app"/"website" never fires; `taskRequiresNetworkAccess` = verb AND (currency OR online); `instructionIsDataGathering` = verb AND (object OR online OR currency). In `makeServeCanonicalizer` after sanitize, before key-remap: goal needs current data AND no legitimate NETWORK data-gathering task → `FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED`; task instruction requesting live/web fetch without NETWORK → `FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED`. Both IntegrityError = failover-eligible, before pin. Proposal never rewritten (no auto-added cap); a NETWORK task counts only when its own instruction is data-gathering — the anti-dummy rule. Adversarial proofs: `"analyze today's gold price"` + REASONING → typed reject; + legit NETWORK task → PASS; DSH ineligible; codex OFF→`MISSING_LIVE_CAPABILITIES`, ON→eligible; devin eligible; historical goal unaffected; dummy-NETWORK rejected. Focused 41/41; regression 554/554 across 15 files; full suite 3427 pass / 2 known env-only P5 fails; tsc + `rm -rf dist` build + audit (0 high) green. Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R2_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_REPORT.md`.
- **PRV2-A R3 (detector precision — LOCAL_CURRENT_STATE vs CURRENT_EXTERNAL_INFORMATION, same branch / PR #41, pending audit)**: the canonical current/external-data detector now distinguishes local current state from external information. Recency split into STRONG (today/latest/mới nhất/hôm nay...) vs GENERIC `current`/`hiện tại`; new LOCAL_SOURCE_RE (repo/branch/workspace/file/CSV/code/project/local...; mã nguồn/dự án/nhánh/cục bộ) suppresses the requirement unless an online marker coexists — "Review the current code and write a report" and siblings no longer fire. Generic current now requires explicit fetch intent + retrievable/external object or research intent + external subject — never broad output nouns alone. New RESEARCH_RE (research/analyze/nghiên cứu/phân tích/...) + EXTERNAL_SUBJECT_RE (models/versions/releases/APIs/EA/mql5/gold/markets...) close the false-negatives: "Research the latest GPT models", "Nghiên cứu các EA MQL5 mới nhất" require NETWORK. Task-level rule mirrors the same class; recency-qualified research tasks count as legitimate NETWORK gatherers. No proposal rewrite, no auto-injection — untrusted proposal fails typed → failover. Focused 45/45; regression 607/607 (16 files); full suite 3431 pass / 2 known env-only P5 fails; tsc + clean build + audit (0 high) green. Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R3_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_REPORT.md`.
- **PRV2-A R4 (goal↔task subject binding, same branch / PR #41, pending audit)**: the NETWORK task satisfying a goal-level current-data obligation must now gather data relevant to that obligation. New `externalSubjectKeys(text)` extracts canonical subject lexemes (detector vocabulary, singular-normalized, btc→bitcoin/xauusd→gold aliases, VI→EN phrase map: mô hình→model, giá→price, vàng→gold, tin tức→news, thị trường→market, tỷ giá→rate…); `instructionSatisfiesGoalSubject(instr, goal)` requires ≥1 shared canonical lexeme (vacuous when the goal has none). Legitimacy = NETWORK cap + data-gathering instruction + subject overlap; task-level gate unchanged. Proven: "Research the latest GPT models" rejects NETWORK "fetch the latest gold price", accepts subject-bound research task; VI pair reject/pass proven; alias bindings (BTC/XAUUSD) proven. Focused 49/49; regression 607/607; full suite 3435 pass / 2 known env-only P5 fails; tsc + clean build + audit green. Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R4_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_REPORT.md`.
- **PRV2-A R5 (subject identity anchors, same branch / PR #41, pending audit)**: generic subject-class overlap no longer satisfies the current-data obligation — class keys (model/api/version/price...) are now distinguished from identity anchors. New `subjectAnchors(text)`: canonical anchor lexemes (gold, bitcoin, ea, mql4/5, silver, oil, eurusd, usdjpy — VI phrases feed them) + capitalized proper/acronym tokens (GPT, OpenAI, Stripe, USD/VND, BTC→bitcoin, XAUUSD→gold) minus detector vocabulary/function words, pure-ASCII so diacritic fragments can't anchor. Goal has ≥1 anchor → NETWORK task must share one; no anchor → R4 class-overlap preserved. Proven: Claude≠GPT reject/pass, Stripe≠OpenAI reject/pass, all prior bindings retained. Focused 52/52; regression 607/607; full suite 3438 pass / 2 known env-only fails; tsc + clean build + audit green. Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R5_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_REPORT.md`.
- **PRV2-A R6 (case-insensitive identity anchors, same branch / PR #41, pending audit)**: casing no longer a governance signal — `subjectAnchors` adds context-anchor extraction: a non-vocabulary token within ±2 of a subject-class term names the external subject at any case ("gpt models", "openai api"); exclusions extended to local-source vocabulary, digits, post-"." extension fragments. Goal "research the latest gpt models" rejects NETWORK "research the latest claude models", accepts matching "gpt" task; "Research the latest GPT models" accepts lowercase task; openai/stripe matrix proven both directions. All R1–R5 tests retained. Focused 56/56; regression 607/607; full suite 3442 pass / 2 known env-only fails; tsc + clean build + audit green. Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R6_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_REPORT.md`.
- **PRV2-A R7 (adjacent-modifier anchors, same branch / PR #41, pending audit)**: context anchors now take only the single nearest candidate adjacent to each subject-class term — generic descriptors ("commercial", "public") can never falsely bind. Scan breaks at stop/class/extension/non-ASCII boundaries, skips digits only ("gpt 4 models"→gpt). Proven: "commercial claude"≠"commercial gpt" reject/pass, "public stripe"≠"public openai" reject/pass; all R1–R6 tests retained. Focused 59/59; regression 607/607; full suite 3445 pass / 2 known env-only fails; tsc + clean build + audit green. Classification: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_R7_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_PRV2A_PLANNER_CAPABILITY_MODERNIZATION_REPORT.md`.
- **PRV2-B (Goal Contract + Coverage Authority, new branch `devin/…-prv2b-goal-coverage`, base `92aca1d` post-PRV2-A merge, pending audit)**: deterministic `extractGoalContract(goal)` (`src/pair/goal-contract.ts`) projects every goal into `{objective, obligations, deliverables, constraints, prohibitions, deadline, delivery_intent?, output_language?}` with stable ids `OBL_/DEL_/CON_/PRO_/DL_001…`, sha256 `contractDigest`, and quantity bounds preserved as floors — `delivery_intent`/`output_language` reference the existing canonical detectors (one authority per concern; network stays the PRV2-A gate). `assertPlanCoverage` (`src/pair/plan-coverage.ts`) is wired as the single coverage seam in `makeServeCanonicalizer` AFTER dataflow reconcile and BEFORE pin: every obligation needs ≥1 genuine work task (verb class + subject-anchor binding + class/content overlap + quantity floor preserved), every named deliverable needs a canonical producer via `extractTaskDataflow` (basename equivalence, never filename grep), budget ceilings are directly validated, everything else PRESERVED-never-PROVEN, prohibitions checked against instruction terms + prohibited capabilities, bookkeeping excluded, and a model `pair_coverage` mapping is evidence only — fabricated claims are INCOMPLETE. Failures are `IntegrityError` (`FAIL_CLOSED_PLAN_INCOMPLETE` / `FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION`) → attempt FAILED → existing failover; replans traverse the same canonicalizer against the same contract (HOW not WHAT). Planner prompt injects the contract block (verified-independently guidance). Adversarial matrix A–M proven (20 focused tests) incl. real `runPlannerFailover` candidate#1-incomplete→#2-wins. Regression: PRV2-A 59/59, F3-R1 20/20; full suite 3465 pass / 2 known env-only P5 fails; tsc + `rm -rf dist` build + audit (0 high) clean. Classification: `PAIR_NEXT_PRV2B_GOAL_CONTRACT_COVERAGE_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_PRV2B_GOAL_CONTRACT_COVERAGE_REPORT.md`.
- **PRV2-B R1 (clause multi-dimension + only-constraint contradiction + canonical DEL equivalence, same branch `devin/1791115082-prv2b-goal-coverage` / PR #42, base audited `aa8a84b`, pending audit)**: R1.A — `extractGoalContract` no longer early-continues per dimension: a clause mints every orthogonal row it states ("research 20 MQL5 EAs by 31/10" → OBL_001 min=20 + DDL_001; "research MQL5 EAs only" → OBL + only-CON), prohibition/telegram clauses stay exclusive, and produce+file-only clauses stay DEL-only while extra non-produce verbs mint obligations. R1.B — `only X` bounds extract `onlyTerms` (only X / X only / chỉ X, versioned-token preference) and get deterministic contradiction detection: versioned-family siblings (task `mql4` under `only mql5`) and bounded channel siblings (task `slack` under `only telegram`) → `FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION`; unenumerable bounds stay PRESERVED-never-PROVEN, permitted-value evidence → PROVEN, budget ceiling unchanged. R1.C — `taskProducesDeliverable` delegates to the single canonical `artifactNamesEquivalent()` (DSN-1): `outbox/<basename>` staging alias equivalent, `dirA/x ≢ dirB/x` never — removed the local basename rule. Focused 36/36 (20 retained + 16 R1); regression 711/711 (PRV2-A 59, F1×3, F2×4, F3×4, F4, F5, DSN-1, telegram, dataflow, CPL-1, CNI-1); full suite 3481 pass / 2 known env-only P5 fails; tsc + `rm -rf dist` build + audit (0 high) green. Classification: `PAIR_NEXT_PRV2B_GOAL_CONTRACT_COVERAGE_R1_PENDING_AUDIT`. Full evidence: `PAIR_NEXT_PRV2B_GOAL_CONTRACT_COVERAGE_REPORT.md`.
