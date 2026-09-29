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
