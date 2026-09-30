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

## P14 Workforce V2 Phase 1 candidate state (on branch, pending audit)

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
  digest over all anchors. Validation anchors the pin to durable revision
  evidence (ACR row) AND to the append-only contract event journal, and
  requires the stored snapshot ⊆ `policyAuthoritySnapshot(ACR.policy)` —
  replace-and-rehash, foreign-contract, nonexistent-version, and
  real-earlier-version rewind all fail closed.
- **Dependency authority:** WDS manifests (explicit empty set included)
  remain the sole proof of a node's dependency list — a WGE scan alone
  never establishes "no dependencies". **Reconcile** validates WGE/WDEL/
  WDEC/WDS/WGM/WAB rows and sweeps all work items bidirectionally;
  corrupt canonical rows poison both endpoints; never rebuilt from
  mutable mirrors; idempotent across restarts.
- Evidence: `PAIR_OS_VNEXT_P14_WORKFORCE_V2_PHASE1_REBASELINE_REPORT.md`;
  suite `pair-p14-workforce-v2.test.ts` (55 — incl. 11 `P14RB-P1-*`
  inverse-provenance/anchor tests) + fresh-server E2E (tamper → 409
  PROVENANCE_CORRUPT ×3, restart-quarantine durable).
  Classification: **`P14_WORKFORCE_V2_PHASE1_REBASELINED_PENDING_AUDIT`**.

## Not yet

- Autonomous heartbeat/inbox/delegation/work-graph (P14 workforce —
  beyond the V2 foundation), CEO agent / KPI gap analysis (P15).
  Intentionally deferred.

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
