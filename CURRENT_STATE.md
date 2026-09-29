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

### P14 — autonomous workforce + governed work graph

- **Canonical work graph on `work_item`** (no second execution path):
  `parent_work_item_id`, `depends_on[]`, `required_capability`,
  `requires_review`, `reviewer_agent_id`, delegation provenance
  (`delegated_from_*`, `delegated_by_agent_id`, `delegation_reason`,
  `delegation_depth`, `delegation_key`), `decomposition_id`,
  `blocked_code`. Edges are scope-validated + acyclic at write
  (`FAIL_CLOSED_WORK_GRAPH_{CYCLE,NODE,SCOPE,BOUND}`); dep mutation only
  via CAS `updateWorkItemDeps`.
- **Lifecycle**: `REVIEW_REQUIRED` state; `openWorkItem` gates on
  `FAIL_CLOSED_WORK_ITEM_DEPENDENCY` until every prerequisite is DONE.
  Terminal prereq → dependents `WORK_BLOCKED`/`DEPENDENCY_FAILED`;
  prereq DONE → dependents promote `WORK_READY`. `rebuildReadiness`
  reconstructs from canonical state on board/inbox/heartbeat.
- **WorkforceService** (`src/pair/workforce.ts`) — coordination only:
  `workGraph`, `agentInbox` (READY/IN_PROGRESS/BLOCKED/
  WAITING_DEPENDENCY/REVIEW_REQUIRED/recently-completed projections),
  `assignWork`/`autoAssign` (`BLOCKED_CAPABILITY` when no eligible
  agent), `delegateWorkItem` (same-business ACTIVE agents, depth cap 5,
  capability narrowing, deterministic `WI_DL_*` ids → exactly-once),
  `decomposeWorkItem` (proposal validated + materialized, deterministic
  `WI_DC_*` ids, ≤16 children, canonical business context),
  `heartbeat` (claim CAS → `openWorkItem` seam → sync sweep).
- **Review**: `reviewWorkItem` ACCEPT → DONE / REWORK → READY; reviewer
  must be ACTIVE same-business and never the producing assignee
  (`FAIL_CLOSED_WORK_REVIEW_SELF`).
- **APIs**: `GET /api/workforce/(graph|inbox)`, `GET
  /api/work-items/:id/children`, `POST /api/workforce/heartbeat`,
  `POST /api/work-items/:id/(delegate|decompose|review|auto-assign)`,
  `POST /api/work-items` + `POST /api/org-agents` extended with graph
  fields / `capabilities`.
- **R1 remediations (post-audit)**: graph dep mutation + node cap +
  create run inside `store.immediate()` — concurrent reciprocal edge
  writes cannot form a cycle; `decomposeWorkItem` is one serialized txn
  (bind + validate + children + evidence) — same-id replay idempotent,
  different-id loser `FAIL_CLOSED_WORK_DECOMPOSE_CONFLICT`, crash rolls
  back clean; named `reviewer_agent_id` enforced
  (`FAIL_CLOSED_WORK_REVIEWER_MISMATCH`); review decision strict enum
  (`FAIL_CLOSED_WORK_REVIEW_DECISION`); parent completion gated on
  mandatory children (`CHILD_INCOMPLETE` park → auto-release at all-DONE,
  `FAIL_CLOSED_PARENT_INCOMPLETE` on early ACCEPT); `agentInbox` strictly
  read-only (reconciliation on heartbeat/board seams); capability
  admission enforced at create/decompose/rebuild.
- Classification: **`P14_PROVENANCE_REBASELINED_PENDING_AUDIT`** — branch
  `devin/1790682872-p14-autonomous-workforce`, DO NOT MERGE. Evidence in
  `PAIR_OS_VNEXT_P14_AUTONOMOUS_WORKFORCE_WORK_GRAPH_REPORT.md` §R1–§RB.
  Rebaseline: `work_open_binding` is the durable canonical authority —
  `BusinessLayer` creates it BEFORE mission creation and pins
  `mission_id` up front (`createMission`/`startMission` accept a pinned
  id, CAS fails closed on collision, `FAIL_CLOSED_MISSION_PIN` guards the
  pin); the row link and `INTENT → BOUND` flip commit in one
  `store.immediate()`. All proof helpers (`missionBoundToWorkItem`,
  `boundMissionForWorkItem`, `proveWorkItemDone`,
  `proveReviewAcceptance`) derive from the binding — mission metadata is
  observability only and can never constitute authority.
  `reconcileOpenIntent` adopts only the binding-pinned mission (forged
  metadata never links); rollbacks mark the binding `ROLLED_BACK`;
  `reviewWorkItem` requires a bound COMPLETED mission before ACCEPT or
  REWORK; delegation restart repair requires the child's
  `required_capability` to equal the parent's (no authority widening).
  R6 closures: grounded proof is now a canonical predicate —
  `missionBoundToWorkItem` / `boundMissionForWorkItem` /
  `proveReviewAcceptance` / `proveWorkItemDone` are shared
  `BusinessLayer` methods used by EVERY authority seam, not only the
  recovery sweep. `syncWorkItem` validates mission binding before any
  fold (foreign mission → quarantine, nothing written/propagated);
  `evaluateParentCompletion` requires the parent's bound COMPLETED
  mission; `depsSatisfiedDeps` + `mandatoryChildrenComplete` require
  proven DONE, not flag-clean status — even before a sweep runs;
  `autoAssign` carries the quarantine guard first (no
  `BLOCKED_CAPABILITY` laundering); restart `WORK_DELEGATED` repair
  validates full row provenance (parent/business/agents/depth/
  deterministic id) before emitting; `blockWorkItem`/`cancelWorkItem`
  never touch a foreign mission. `childNodeId` exported from
  `business.ts` as the single deterministic-id definition.
  R5 closures (metadata-bound proof superseded by the RB `work_open_binding`
  authority): `TERMINAL_PROVENANCE_CORRUPT` is a hard quarantine — the
  centralized `assertWorkItemNotQuarantined` guard fails
  `FAIL_CLOSED_WORK_PROVENANCE_CORRUPT` at open/claim/assign/review
  (ACCEPT+REWORK)/deps mutation/delegation/decomposition; corrupt rows
  surface as blocked in the inbox, are never re-promoted by
  `rebuildReadiness`, fold nothing via `syncWorkItem`, and propagate
  nothing. Mission proof is strongly bound (`metadata.work_item_id` +
  `business_id` + `source=business_layer` + `work_item_open_id`); a
  reviewed DONE requires a bound COMPLETED mission AND exactly one
  provenance-validated `WORK_REVIEW_ACCEPTED` (states, reviewer scope,
  non-self, named-reviewer match — duplicates/malformed quarantine);
  a legacy valid ACCEPT repairs only its derived effects under a named
  recovery marker.
  R3 closures: delegation completeness now requires row provenance AND the
  canonical WORK_DELEGATED audit — `ensureDelegationEvent` repairs a
  missing event / fails `FAIL_CLOSED_WORK_DELEGATE_CONFLICT` on conflict,
  inside the same delegation transaction; `finalizeWorkItem` and
  `reviewWorkItem` each commit their full effect set (write + propagation
  + context + event) in one `store.immediate()` — crash → rollback, retry
  converges; `reconcileTerminalConsistency` at the head of
  `rebuildReadiness` idempotently repairs legacy partial terminal state.
  R4 closures (superseded by R5 where tightened): recovery is grounded-proof only — status alone is never
  evidence; per-state canonical proofs (completed mission / stored
  WORK_REVIEW_ACCEPTED / cancel vs mission-cancel / blocker evidence);
  ungrounded terminal rows quarantine as `TERMINAL_PROVENANCE_CORRUPT` +
  one `WORK_PROVENANCE_INCONSISTENT` event — no dependent promotion
  (`depsSatisfied`), no parent release (`mandatoryChildrenComplete`), no
  synthetic events or success context; grounded repairs emit a named
  `WORK_TERMINAL_REPAIRED` marker, never a fabricated transition;
  WORK_REVIEW_ACCEPTED is never reconstructed; `WORK_DELEGATED` audit is
  indexed globally by `child_work_item_id` — entity_id/key/from/to
  mismatch or duplicate events fail closed at both replay and restart.
  Totals: P14 91/91 (7 rebaseline tests), P13 67/67, P12 71/71,
  P11 103/103, P9 79/79, N22 2014/2env, N20 2016/0, typecheck+build PASS,
  audit 0 high/0 critical, verifyIntegrity clean.

## Not yet

- CEO agent / KPI gap analysis (P15), always-on heartbeat daemon.
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
