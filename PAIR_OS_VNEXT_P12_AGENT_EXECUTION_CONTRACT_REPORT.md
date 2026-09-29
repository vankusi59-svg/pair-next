# PAIR OS VNext — P12 Agent Execution Contract Report

**Base authority:** main `c2622d9e4f07f1a1308b0a403e79d12b2268d855`
(`P11_OFFICIAL_FINAL_PASS`)
**Branch:** `devin/1790663627-p12-agent-execution-contract`
**Classification:** `P12_IMPLEMENTED_PENDING_AUDIT`

P12 turns `org_agent` from an organizational record into an enforceable
AI-employee execution identity via a single canonical, versioned
`agent_execution_contract`. A contract only NARrows existing PAIR
authority — it can never expand capabilities, executors, routes, projects,
or context beyond what the governed engine already permits.

---

## 1. Architecture survey / placement

No second execution engine. The contract adds one entity plus policy
checks layered onto the canonical path:

```
BusinessLayer (contract CRUD + baseline materialization)
    ↓
MissionControl.startMission — assert + PIN contract {id,version,digest,policy}
    ↓
Planner (unchanged — advisory only)
    ↓
MissionRouter.routeGovernedTask — resolve effective policy; filter executor
                                   candidate set; pass route policy to selector
    ↓
GovernedTaskGate.create_governed_task — AUTHORITATIVE capability/executor/
                                        project enforcement
    ↓
RouteSelector.select — preferred/denied/restricted route policy
    ↓
Executor → Recovery/Reconciliation → Verified Experience (unchanged)
```

`effective_for_mission = mission_pinned_policy ∩ current_contract ∩
existing PAIR authority`. Deny sets UNION across pinned and current
(deny always wins); allow sets INTERSECT (the tighter bound applies);
contract allow-lists are then capped by the PAIR capability registry —
a contract can never name authority PAIR does not have.

## 2. Contract schema (`agent_execution_contract` table)

Deterministic id `AEC_<digest(agent-execution-contract:<agent_id>)[0:24]>`
— exactly one contract per agent, enforced by CAS insert, not by lookup.

Identity fields: `contract_id`, `org_agent_id`, `business_id`,
`schema_version` (`pair.os.vnext.agent-execution-contract.v1`), `status`
(`ACTIVE|DISABLED`), `contract_version` (monotonic, starts 1),
`contract_digest` (canonical digest of id+agent+business+version+policy),
`policy`, `created_by`, `created_at`, `updated_at`, store `version`
(CAS key).

`policy` (normalized fail-closed, unknown fields rejected):
- `allowed_capabilities: string[] | null` — null = no contract narrowing
- `denied_capabilities: string[]`
- `allowed_executor_ids: string[] | null`
- `denied_executor_ids: string[]`
- `preferred_executor_ids: string[]` (ordered; advisory reorder inside
  the eligible set only)
- `executor_fallback_allowed: boolean`
- `preferred_route_ids: string[]`, `denied_route_ids: string[]`,
  `route_fallback_allowed: boolean`
- `allowed_project_ids: string[] | null`
- `allowed_context_scopes: subset of {business, project, agent, experience}`

Policy validation at write time: every capability named in
allowed/denied must exist in the PAIR capability registry
(`FAIL_CLOSED_AGENT_CAPABILITY_UNKNOWN`) — a contract cannot reference
unregistered authority; context scope names are closed.

## 3. Enforcement locations

| Point | Check |
|---|---|
| `MissionControl.startMission` | `assertExecutable` (agent ACTIVE, contract ACTIVE, business match, project in scope) + write `metadata.agent_contract` pin |
| `GovernedTaskGate.create_governed_task` | re-resolve `effectiveForMission` (status, business, pin digest, provenance); explicit-deny → `FAIL_CLOSED_AGENT_CAPABILITY_DENIED`; allow-list ⊆ required → same; executor ∉ allowed ∪ denied → `FAIL_CLOSED_AGENT_EXECUTOR_DENIED`; project ∉ scope → `FAIL_CLOSED_AGENT_PROJECT_DENIED` |
| `MissionRouter.routeGovernedTask` | resolve policy once per pass; candidates filtered to `allowed−denied`; empty set → `FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR` (audited); `preferred_executor_ids` forwarded to CapabilityRouter; route policy forwarded to RouteSelector |
| `CapabilityRouter.route` | `preferredExecutors` re-rank inside the eligible set only — eligibility is computed BEFORE preference, so preference cannot qualify anything |
| `RouteSelector.select` | hard rejections `AGENT_CONTRACT_ROUTE_DENIED`, `AGENT_CONTRACT_ROUTE_RESTRICTED` (when `route_fallback_allowed=false`); preferred routes promoted to front of eligible; persisted `agent_route_policy` on the decision receipt |
| `BusinessLayer.openWorkItem` | goal context injection gated on `allowed_context_scopes` (`business` → org prefix, `agent` → identity + outcome notes) |

Every contract-caused rejection emits `AGENT_EXECUTION_DENIED` on the
`org_agent` entity (reason code + detail + mission/task/contract_version).
Resolution-time failures (inactive agent, disabled contract, digest
mismatch, provenance) are caught at each enforcement point and audited
before re-throw — there is no silent deny path.

## 4. Provenance & revocation

- Every agent-bound mission carries `metadata.agent_contract =
  {contract_id, org_agent_id, business_id, contract_version,
  contract_digest, schema_version, policy_snapshot}`.
- At gate time the pin is re-digested from its own snapshot; mismatch →
  `FAIL_CLOSED_AGENT_CONTRACT_DIGEST`; pin claiming a future version →
  `FAIL_CLOSED_AGENT_CONTRACT_PROVENANCE`.
- Contract updates never rewrite stored pins — historical missions keep
  their V<n> evidence permanently.
- **Tightening revokes in-flight**: a task routed after a deny/narrow
  update fails closed even though its mission was pinned under the older
  looser policy (pinned ∩ current).
- **Expansion never retro-broadens**: a mission pinned while SHELL was
  denied stays denied after the deny is later removed (deny-union).

## 5. Legacy migration (§6)

- `createOrgAgent` auto-materializes a baseline contract (audit event
  `AGENT_EXECUTION_CONTRACT_CREATED` when a policy is supplied,
  `AGENT_EXECUTION_CONTRACT_MATERIALIZED` for the baseline).
- Pre-P12 `org_agent` rows materialize their baseline lazily on first
  bound mission — never "missing contract = allow everything".
- Baseline narrows nothing except project scope (pinned to the agent's
  own business project) — existing behavior preserved.

## 6. API surface (`/api/org-agents/:id/...`)

- `GET .../contract` — raw contract (null if unmaterialized)
- `POST|PUT .../contract` — create/upsert policy; CAS via `version`
  (`expected_version` honored; concurrent writers → one
  `FAIL_CLOSED_VERSION_CONFLICT`)
- `POST .../contract/enable` / `.../disable` — status transitions + audit
- `GET .../effective-policy` — resolved inspection view (no secret
  material anywhere in the contract model)

## 7. Fail-closed conditions (§18 mapping)

| Condition | Code |
|---|---|
| agent PAUSED/TERMINATED | `FAIL_CLOSED_AGENT_INACTIVE` |
| contract DISABLED | `FAIL_CLOSED_AGENT_CONTRACT_DISABLED` |
| contract.business ≠ agent.business | `FAIL_CLOSED_AGENT_CONTRACT_SCOPE` |
| mission.business ≠ agent.business | `FAIL_CLOSED_AGENT_BUSINESS_MISMATCH` |
| pin digest mismatch / forged | `FAIL_CLOSED_AGENT_CONTRACT_DIGEST` |
| pin version > current | `FAIL_CLOSED_AGENT_CONTRACT_PROVENANCE` |
| capability denied / outside allow-list | `FAIL_CLOSED_AGENT_CAPABILITY_DENIED` |
| capability unregistered at write | `FAIL_CLOSED_AGENT_CAPABILITY_UNKNOWN` |
| executor denied / not allowed / empty set | `FAIL_CLOSED_AGENT_EXECUTOR_DENIED` / `FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR` |
| route denied / restricted unmet | route hard rejections → `FAIL_CLOSED_NO_ELIGIBLE_ROUTE` |
| project out of scope | `FAIL_CLOSED_AGENT_PROJECT_DENIED` |
| concurrent update | `FAIL_CLOSED_VERSION_CONFLICT` |

## 8. Tests — `src/__tests__/pair-p12.test.ts` (34)

- **A. lifecycle** (5): materialize-on-create + event; CAS update bumps
  contract_version + re-digest; stale version fails; disable/enable +
  inspect view; unknown capability rejected at write.
- **B. legacy** (1): pre-P12 agent row → baseline materializes on first
  pin + audit event + mission carries the pin.
- **C. business isolation** (2): cross-business mission denied at pin;
  forged contract business → `CONTRACT_SCOPE`.
- **D. capabilities** (4): allow-list routes; missing cap denied +
  audited; deny-wins over allow; unregistered cap fails closed.
- **E. status** (3): PAUSED agent denied at pin; DISABLED contract denied
  at gate + audited; mid-mission pause revokes at gate.
- **F. executor policy** (5): preferred overrides routing priority;
  allowed-list narrows; denied removed; empty eligible → fail closed;
  fallback to next eligible.
- **G. route policy** (4): preferred route selected despite priority;
  denied hard-rejected with `AGENT_CONTRACT_ROUTE_DENIED`; restricted
  (no fallback) → `NO_ELIGIBLE_ROUTE`; fallback allowed → eligible serves.
- **H. project scope** (2): foreign project denied at pin; mid-flight
  revocation denied at gate.
- **I. provenance** (3): pin immutable across contract update; tampered
  digest fails; future-version pin fails.
- **J. revocation** (2): tightening revokes in-flight; expansion never
  retro-broadens a pinned mission.
- **K. planner** (1): planner-emitted denied capability still denied.
- **L. CAS race** (1): real `worker_threads` + SharedArrayBuffer barrier,
  two workers same expected version → one winner, one
  `FAIL_CLOSED_VERSION_CONFLICT`, one row, `verifyIntegrity` clean.
- **M. context scopes** (1): `allowed_context_scopes` removes org/agent
  injection from the mission goal.

## 9. Validation evidence

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `pnpm run build` | pass |
| P11 focused (103) Node 22 | 103/103 |
| P12 (34) Node 22 | 34/34 |
| P11+P12 focused Node 20 | 137/137 |
| Full suite Node 22 | 1819 pass / 2 fail (pre-existing env-dependent pair-p5 DSH/CODEX probes — binaries present in PATH on dev box; green on clean CI envs) / 24 skipped |
| Full suite Node 20 | 1821 pass / 0 fail / 24 skipped |
| `pnpm audit --audit-level=high` | 0 high, 0 critical (1 low, 8 moderate) |
| `verifyIntegrity` after concurrent CAS race | clean (asserted in test L) |
| Genuine worker_threads contention | contract update race (this file) + P11 schedule/budget/claim races (unchanged, green) |

## 10. Security notes

- Contract rows carry policy only — no credentials, tokens, or secret
  material; the model has no field that could hold them.
- Denial audit events log reason codes + capability/executor/route ids —
  never tool payloads or context content.
- Context injection into mission goals is reference-free (existing
  context_notes); `allowed_context_scopes` removes it wholesale.
- No new network surface: four HTTP routes added inside the existing
  authenticated server, all behind `operator_id` actor checks and CAS.

## 11. Limitations / non-scope

- `preferred_executor_ids`/`preferred_route_ids` are advisory ordering
  inside the eligible set — preference can never qualify, only order.
- Route preferences bind to the *already-selected* executor's routes;
  a route belonging to another executor does not redirect executor
  selection (canonical authority — capability routing first, route
  second).
- No P13 (cost/secrets/quotas), P14 (heartbeat/inbox/self-claim/
  delegation), P15 (CEO/KPI) scope. No memory engine added —
  context scopes only gate existing injection.
- `executor_binding` on org_agent maps to baseline
  `preferred_executor_ids[0]` when it names a registered executor;
  it is a preference, not a bypass.

---

# R1 — Independent-audit remediation (authority/provenance closure)

Audit classification: `P12_BLOCKED` at head `289c285`.
Six defects found and closed. All changes preserve the canonical
execution path (Business → MissionControl → Planner → MissionRouter →
GovernedTaskGate → Executor) — no second engine, no bypass.

## R1.1 `executor_fallback_allowed=false` was advisory-only — FIXED

**Defect:** the flag was computed but MissionRouter never used it;
`preferred_executor_ids` never became a hard restriction, so EXEC_B
could be selected when preferred EXEC_A was unavailable.

**Fix:** `effectiveForMission` now derives `restricted_executor_ids`:

- per snapshot: `fallback_allowed=false` + non-empty
  `preferred_executor_ids` → the preferred set is a **hard restriction**;
- effective restriction = `pinned ∩ current` (absent = unconstrained);
- effective executor allow = `allowed_executor_ids` (pinned∩current,
  null=unrestricted) ∩ `restricted` − `denied_executor_ids` (union);
- preference only *orders* within the effective set — it can never make
  an executor eligible (`preferred_executor_ids` filtered through the
  same predicate).

Enforced at **two** layers: MissionRouter candidate filter (prevents
selection) and GovernedTaskGate's authoritative executor check (prevents
dispatch). Empty result → `FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR` + audited
denial.

**Tests A–D:** fallback=false+preferred down → no dispatch; eligible
preferred executes; pinned no-fallback A ∩ switched current no-fallback
B → empty → fail closed; deny-union tightening still revokes.

## R1.2 Missing contract pin silently substituted current contract — FIXED

**Defect:** `metadata.org_agent_id` present without
`metadata.agent_contract` → `pinnedPolicy` returned null and the
*current* contract became sole authority — provenance not immutable.

**Fix:** any `org_agent_id`-bound mission reaching governed execution
**must** carry a valid pin. Missing → `FAIL_CLOSED_AGENT_CONTRACT_PIN_MISSING`,
audited `AGENT_EXECUTION_DENIED`, no dispatch. Pre-P12 in-flight
missions fail closed (explicit remediation/re-issue; no invented
provenance). Pin-vs-current checks kept: contract_id/org_agent match,
business match, `pinned_version ≤ current_version`.

**Test:** pin stripped → PIN_MISSING + denial event + zero dispatch.

## R1.3 Pinned route restriction could be retro-broadened — FIXED

**Defect:** route selection used *current* `preferred_route_ids` only —
a pinned `route_fallback_allowed=false` snapshot's hard set was ignored.

**Fix:** `restricted_route_ids` derived identically to §R1.1:
`route_fallback_allowed=false` + non-empty preferred → hard set per
snapshot; effective = `pinned ∩ current`, minus denied union (deny wins).
Empty → selector rejects every route
(`AGENT_CONTRACT_ROUTE_RESTRICTED`) → `FAIL_CLOSED_NO_ELIGIBLE_ROUTE`.
Advisory `preferred_route_ids` (fallback=true snapshots) only reorders
inside canonical eligibility.

**Selector fix:** `restricted_route_ids` non-null is now an active
allow-set even when empty (was `restricted.length` truthy-gated —
an empty set meant "unrestricted").

**Tests A–D:** pinned no-fallback A + current prefers ALT → selects A
(B never authorized); A∩ALT both no-fallback → empty → NO_ELIGIBLE_ROUTE;
both advisory → current preference reorders legitimately; denied-in-
preference → NO_ELIGIBLE_ROUTE.

## R1.4 Current contract integrity not revalidated — FIXED

**Defect:** only the *pinned* digest was verified; the live contract row
used for revocation/effective policy was trusted blindly.

**Fix:** canonical `validateContractRow(agent, contract)` helper invoked
in `resolve()` — the choke point of pin, assertExecutable,
effectiveForMission, update, setStatus, inspect. Validates:
`contract_id == contractIdFor(org_agent_id)`, org_agent/business
binding, `schema_version == AGENT_CONTRACT_SCHEMA`, status ∈
{ACTIVE,DISABLED}, `contract_version` positive int, policy normalizes,
recomputed `contractDigest == stored digest`. Tamper → fail closed.

**Tests A–D:** tampered policy + stale digest, tampered digest, wrong
schema_version all fail closed; valid contract unaffected (the whole
suite is the control).

## R1.5 Unknown policy fields silently ignored — FIXED

**Defect:** `normalizeContractPolicy` dropped unknown keys — a typo
(`allowed_executor_id`) silently produced unrestricted semantics.

**Fix:** canonical `POLICY_KEYS` allow-list (11 fields); any extra key →
`FAIL_CLOSED_AGENT_CONTRACT_FIELDS`. Applies at write (upsert) and at
every resolution (validateContractRow re-normalizes stored policy).

**Test:** typo/extra fields rejected at upsert.

## R1.6 Pin-time denial unaudited — FIXED

**Defect:** `startMission → pin()` failures propagated without an
`AGENT_EXECUTION_DENIED` record.

**Fix:** `startMission` wraps `pin()` — PolicyError/IntegrityError →
`auditDenial(code, message, {agentId})` then rethrow. Downstream
(gate/router) catches still audit resolution-time denials; each failure
audits exactly once at its own choke point — no double-audit.

**Tests:** inactive agent, project-denied → one denial event each with
matching `reason`.

## R1.7 Semantics recap (final)

```
restricted_exec(snapshot)  = !executor_fallback_allowed ∧ preferred ≠ ∅ → preferred | null
restricted_route(snapshot) = !route_fallback_allowed    ∧ preferred ≠ ∅ → preferred | null

effective_executor_set = allowed_exec(pinned∩current, null=*) ∩ restricted_exec(pinned) ∩ restricted_exec(current) − denied_exec(∪)
effective_route_set    = restricted_route(pinned) ∩ restricted_route(current) − denied_route(∪)   [hard only]
advisory order         = current.preferred filtered to the effective set; preference never qualifies
```

- Missing pin on agent-bound mission → `FAIL_CLOSED_AGENT_CONTRACT_PIN_MISSING`.
- Every contract row resolved for authority passes
  `validateContractRow` (id/agent/business/schema/status/version/policy/digest).
- Unknown policy keys → `FAIL_CLOSED_AGENT_CONTRACT_FIELDS` at write
  and at read.
- Denials audit `AGENT_EXECUTION_DENIED` (org_agent entity,
  `metadata.reason`) at pin-time and at every governed choke point.

## R1.8 Validation evidence (Node 22.23.3, pnpm)

- `tsc --noEmit` — PASS
- `pnpm build` — PASS
- P12 suite: **49/49** (34 baseline + 15 new R1)
- P11 regression: **103/103**
- Full suite, Node 20 + Node 22 — see §10 report-back / test evidence
- `pnpm audit --audit-level=high` — 0 high / 0 critical
- `PairEvidenceStore.verifyIntegrity` — clean after R1 suites
- P12 worker_threads CAS race — PASS (1 winner / 1
  FAIL_CLOSED_VERSION_CONFLICT, single row, version bumped once)
- P11 worker races — unchanged, PASS

## R1.9 Classification

`P12_REMEDIATED_R1_PENDING_AUDIT` — DO NOT MERGE; independent audit
required. No P13/P14/P15 work performed or implied.

---

# R2 — Final pre-dispatch authority revalidation + pin hardening

Audit classification at R1 head `10bd894`: `P12_BLOCKED` — one remaining
crash/restart execution-authority gap plus pinned-provenance hardening.
All fixes preserve the canonical path; GovernedTaskGate remains the
authoritative enforcement boundary.

## R2.1 Defect — adopted governed task could bypass later revocation

**Gap:** `MissionRouter.routeGovernedTask` resolved
`effectiveForMission` for routing, but when a `governed_task` already
existed (`existingGovernedTask`) it was adopted → `authorize_dispatch` →
`dispatch_governed_task` — and the P12 checks embedded in
`create_governed_task` were never re-run. Sequence: V1 allows →
VALIDATED task persisted → crash → V2 revokes → restart → adopted task
dispatched under dead authority.

## R2.2 Fix — canonical `assertAgentExecutionAllowed`

`GovernedTaskGate.assertAgentExecutionAllowed(mission, task, executorId)`
extracts the P12 contract block verbatim and is now invoked at **two**
boundaries so the paths cannot drift:

1. `create_governed_task` (unchanged authority at validation time);
2. `dispatch_governed_task` — the final authoritative boundary,
   immediately before a NEW `adapter.dispatch` call.

It validates: bound-mission pin (required, digest, schema, version,
provenance vs current), agent ACTIVE, contract ACTIVE + row integrity
(`resolve → validateContractRow`), business identity, project scope,
`required_capabilities` (explicit deny first, then allow-list),
executor (denied ∪, allowed ∩, restricted ∩), and the bound route
(`task.selected_route_id` vs denied/restricted — FAIL_CLOSED_AGENT_ROUTE_DENIED
/ FAIL_CLOSED_AGENT_ROUTE_RESTRICTED). Denials audit
`AGENT_EXECUTION_DENIED` exactly once at the point of failure.

## R2.3 Idempotency — already-dispatched work is historical fact

The check sits **after** the intent early-returns, so:

- `EXECUTION_PERSISTED` + `execution_id` → return the existing
  execution; never re-validated retroactively, never re-dispatched.
- `INTENT_RECORDED` + `adapter.dispatch_evidence.dispatched` →
  reconcile intent to EXECUTION_PERSISTED and return that execution.
- **Only** when a fresh `adapter.dispatch` is imminent does the current
  effective contract get re-validated — tightening revokes the future
  action: FAIL CLOSED, zero dispatch, denial audited.

Recovery/reroute is untouched — a denied adopted task can still be
reworked through the canonical recovery path.

## R2.4 Route revalidation

The canonical `task.selected_route_id` (bound at ROUTE_BOUND, persisted
on the task row) is checked at pre-dispatch against the effective route
policy — denied union ∪ and non-null restricted set ∩ — with the same
fail-closed semantics as route selection. A bound-but-never-dispatched
task on a since-revoked route cannot execute; no silent rerouting.

## R2.5 Pinned provenance hardening

`pinnedPolicy` now also requires `pin.schema_version ===
AGENT_CONTRACT_SCHEMA` and `pin.contract_version` integer ≥ 1 —
explicitly, because `contractDigest` injects the canonical schema
internally so a tampered schema field alone would not disturb the
digest. Order: schema → version → digest → contract/provenance binding.

## R2.6 Tests (10 new — describe P12.R2 + P12.R2.6)

- **A–E (crash/restart, real persisted state):** governed task
  persisted VALIDATED (executor+route bound, no dispatch) → contract
  tightened → router adoption → FAIL CLOSED + 0 adapter dispatches:
  capability deny (`FAIL_CLOSED_AGENT_CAPABILITY_DENIED`), executor
  deny (`FAIL_CLOSED_AGENT_EXECUTOR_DENIED`), hard executor restriction
  switch (same code), route deny (`FAIL_CLOSED_AGENT_ROUTE_DENIED`),
  hard route restriction switch (`FAIL_CLOSED_AGENT_ROUTE_RESTRICTED`).
- **F:** completed dispatch + EXECUTION_PERSISTED → tighten → re-route
  returns the SAME execution; `dispatched` stays 1; 1 execution row.
- **G:** INTENT_RECORDED + `dispatch_evidence.dispatched` → tighten →
  reconcile returns existing execution; still 1 dispatch / 1 row.
- **R2.6 A–C (pin hardening):** tampered `pin.schema_version` with
  still-valid digest → `FAIL_CLOSED_AGENT_CONTRACT_PROVENANCE`;
  `contract_version` 0 and −1 with recomputed digest → FAIL CLOSED.

## R2.7 Validation evidence

- `tsc --noEmit` PASS · `pnpm build` PASS
- P12 suite: **59/59** (49 + 10 R2) · P11 regression: **103/103**
- Full suite Node 22.23.3: **1844 pass** / 2 pre-existing env-dependent
  p5 probe failures (dsh/codex binaries on PATH of this dev box —
  documented since P11) / 24 skipped
- Full suite Node 20.20.2: **1846 pass / 0 fail** / 24 skipped
- `pnpm audit --audit-level=high`: **0 high / 0 critical**
- P12 worker_threads CAS race: PASS (inside suite) · P11 worker races:
  unchanged, PASS · `verifyIntegrity`: clean

## R2.8 Classification

`P12_REMEDIATED_R2_PENDING_AUDIT` — DO NOT MERGE; independent audit
required. No P13/P14/P15 work performed or implied.
