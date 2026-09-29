# PAIR OS vNext — P13 COST + SECRETS GOVERNANCE REPORT

## 1. Canonical starting SHA

`f45837ee9fa538a91b70898c9fec858f9c8a4316` — the merge commit of P12 PR #5 on
`main`, confirmed by `git rev-parse HEAD` before the first edit. All P13 work
lives on the new branch `devin/1790669906-p13-cost-secrets-governance` against
new PR. No merge performed.

## 2. Current architecture discovered

- `PairEvidenceStore` (better-sqlite3): all canonical entities, events,
  governed evidence; `store.put` enforces CAS (`expectedVersion` → conditional
  UPDATE / INSERT ON CONFLICT DO NOTHING → `FAIL_CLOSED_VERSION_CONFLICT`);
  `store.immediate(fn)` = `BEGIN IMMEDIATE` transaction; `assertSecretFree`
  already blocks raw secrets in canonical rows (P11).
- `GovernedTaskGate` is the sole external-dispatch authority:
  `create_governed_task` → `dispatch_governed_task` with the R2 pre-dispatch
  `assertAgentExecutionAllowed` boundary and R3/R4 intent + reconciliation
  identity semantics.
- `MissionRouter` routes, `MissionControl` orchestrates,
  `MissionScheduleService` + `BusinessLayer` sit on top.
- `CredentialBroker`: local vault file (`<mc_dir>/vault.json`, chmod 600),
  narrow `x-broker-token` transport auth on `POST /api/broker/fetch`, audited
  grant/deny events. Before P13 the token alone released values — there was no
  secret *authorization* layer.
- P11 `budget_policy`/`budget_reservation` count *missions* (not USD).
- `/api/cost` returned token-bucket telemetry only; no money semantics.

## 3. Existing systems reused

- `PairEvidenceStore` CAS + `store.immediate` atomic transactions.
- `GovernedTaskGate` dispatch/intent/reconciliation machinery (unchanged).
- `assertAgentExecutionAllowed` P12 final pre-dispatch boundary (cost checks
  run *after* it and *before* `adapter.dispatch`).
- `CredentialBroker` vault + transport token (unchanged as a vault/transport;
  authorization layered on top, per §47 — no new vault, no KMS clone).
- `effectiveForMission` P12 effective policy (secret release re-checks it —
  grant never expands P12).
- Mission `metadata` provenance pinning pattern (same mechanism as
  `agent_contract` pin in P12).
- `costHaltFile`/`PAIR_COST_HALT` P9 halt plumbing (preserved verbatim).

## 4. Cost governance architecture

`CostService` (`src/pair/cost.ts`), instantiated inside
`PairControlPlane` (`service.cost`) so every caller shares one authority:

- `upsertCostPolicy` / `upsertCostProfile` — validated, allow-listed fields,
  CAS, audited (`COST_POLICY_CREATED`/`UPDATED`, profile events).
- `assertAndReserve` — called by `dispatch_governed_task` after
  `assertAgentExecutionAllowed`, immediately before `adapter.dispatch`.
- `markCommitted` / `markReleased` / `settle` / `settleFromResult` —
  lifecycle transitions driven by canonical outcomes.
- `reconcileForTask` / `reconcileAll` — crash/restart accounting derived only
  from canonical evidence (dispatch intent state, `executor_execution`,
  `dispatch_evidence`); never TTL, never memory.
- `position()` — read model for `/api/cost`.

New canonical entities (`COST_SCHEMA = "pair.os.vnext.cost.v1"`):

- `cost_policy` `CPO_<ulid>`: business_id, scope_type
  (business|department|agent|mission), scope_id, period
  (DAY|WEEK|MONTH|MISSION_LIFETIME), max_microusd, hard_stop,
  warning_threshold_pct, enabled, actor, created/updated, version.
- `cost_profile` `CPRO_<refType>_<digest>`: ref_type (route|model|executor),
  ref_id, provider_id, model_entry_id, route_id, billing_mode, currency,
  fixed/reserve/input/output microusd, provenance, effective_at, status.
- `cost_reservation` `CRSV_<governedTaskId>` (deterministic per dispatch):
  business/department/agent/route ids, billing_mode, cost_profile_id,
  reserved_microusd, actual_microusd, state HELD|COMMITTED|SETTLED|RELEASED,
  unbounded flag, version.

## 5. Monetary representation

Integer `microusd` only — `assertMicrousd` rejects non-integers and negatives
at every write path. No floats anywhere in cost code. Currency is USD only;
any other `currency` value on a profile → `FAIL_CLOSED_COST_CURRENCY`.

## 6. Cost profile / pricing provenance

Profiles are operator/adapter-supplied *metadata* (`provenance` free-text +
`effective_at` + `status`); no live vendor fetch ever happens in the stack.
`billingFor(executorId, routeId)` resolves route→model→executor profile;
`PAIR_NATIVE` executors default UNMETERED; missing profile → billing_mode
UNKNOWN. METERED_API with neither `reserve_microusd` nor `fixed_microusd`
is "unbounded" (no ceiling known).

## 7. Cost reservation lifecycle

`HELD` (created atomically inside the budget check txn) → `COMMITTED`
(durable adapter dispatch) → `SETTLED` (authoritative actual usage known) or
`RELEASED` (dispatch proven not to have happened / reconcile).
`RELEASED`→`HELD` re-hold supports retry of the same governed task. Every
transition is a CAS `transitionIfCurrent`; a CAS loser adopts the winner's
row — same governed dispatch always lands on `CRSV_<gtid>` (§13 idempotency).
Historical paths (`EXECUTION_PERSISTED`, proven INTENT_RECORDED) call
`reconcileForTask` only — they never create a second reservation.

## 8. Crash/restart accounting

- Crash after reservation, before/during dispatch: row stays HELD; on the
  next dispatch attempt `reconcileForTask` derives truth from intent +
  `executor_execution` + `dispatch_evidence` (intent absent → RELEASED;
  EXECUTION_PERSISTED or evidence dispatched → COMMITTED; evidence
  dispatched=false → RELEASED; ambiguous → stays HELD — never guessed).
- Crash after COMMITTED, before settle: `collect_execution_result` settles
  on the next pass; unknown actual → stays COMMITTED with
  `actual_state=ACTUAL_USAGE_UNKNOWN` (settle from reserved max or stay —
  never under-count).
- A proven external dispatch is never redispatched because cost accounting
  crashed: R3/R4 idempotency still decides dispatch; cost reconcile only
  accounts it.

## 9. Billing mode semantics

METERED_API (charged per use), SUBSCRIPTION (flat — tracked, never priced),
FREE, UNMETERED (e.g. PAIR_NATIVE), UNKNOWN (never coerced to FREE; counted
as `unpriced` in `/api/cost`). Under a hard policy, METERED_API-unbounded or
UNKNOWN billing → fail closed (`FAIL_CLOSED_COST_UNBOUNDED`,
`FAIL_CLOSED_COST_UNKNOWN`). SUBSCRIPTION/FREE/UNMETERED consume no USD and
still get a reservation row for observability.

## 10. Secret governance architecture

`SecretPolicyService` (`src/pair/secret-policy.ts`) inside
`PairControlPlane` (`service.secretPolicies`):

- `secret_policy` `SPOL_<digest24(business:ref)>` — business-scoped, one per
  (business, credential_reference_name); allow-sets
  (agent/executor/project/route ids), allowed_purpose, status
  ACTIVE|REVOKED, policy_version, actor, CAS version, digest over authority
  fields.
- `createPolicy` (dup → `FAIL_CLOSED_SECRET_POLICY_EXISTS`),
  `updatePolicy`/`setPolicyStatus` — immutables business_id + ref;
  `policy_version` increments; `SECRET_POLICY_CREATED/UPDATED/REVOKED`
  events carry metadata only.
- `authorizeRelease({mission, task, credentialRef, executorId})` — the
  ordered fail-closed chain of §25.

## 11. Mission secret pinning

`MissionControl.startMission` pins `metadata.secret_grants` — a sorted
snapshot `{credential_reference_name, policy_id, policy_version,
policy_digest, allowed_*_ids, allowed_purpose}` for every ACTIVE policy of
the mission's business (same provenance pattern as the P12 agent contract
pin). Pin is fixed at mission creation: a policy created later is never
visible to an old mission (K), and a widened policy later does not expand the
pinned snapshot (K2) — effective grant = pinned ∩ current policy.

## 12. Broker authorization flow

`POST /api/broker/fetch` still requires `x-broker-token` (transport auth
only). It now calls `MissionControl.authorizeCredentialFetch(missionId,
taskId, ref)` which runs §25's chain: mission exists → task exists →
task∈mission → pinned grant exists → policy exists → digest recomputed from
pin fields == pin digest (`FAIL_CLOSED_SECRET_PIN_PROVENANCE`) → policy
business == mission business (cross-business deny) → policy ACTIVE →
pinned∩current allow-sets (agent/executor/project/route/purpose) → P12
`effectiveForMission` (throws → `FAIL_CLOSED_SECRET_AGENT_POLICY`;
`denied_executor_ids.has()` → `FAIL_CLOSED_SECRET_EXECUTOR_DENIED`).
Grant → `CREDENTIAL_RELEASE_GRANTED` evidence + `broker.release`;
deny → `CREDENTIAL_RELEASE_DENIED` evidence + `broker.deny` + 403
(`FAIL_CLOSED_MISSION_*/TASK_*` map to 404 to preserve P11 API semantics).
`broker.release` returning null (vault absent) → audited 404
`FAIL_CLOSED_CREDENTIAL_NOT_INSTALLED`.

## 13. Revocation semantics

`setPolicyStatus(REVOKED)` / `updatePolicy` are CAS + audited; revocation
narrows future releases immediately (J). Post-commit revoke cannot alter a
release already granted — historical events preserved. `policy_version`
increments on every mutation so a stale pin digest check and CAS both catch
tamper (integrity tests: pin tamper → PIN_PROVENANCE; stale version →
`FAIL_CLOSED_VERSION_CONFLICT`).

## 14. P12 interaction

Release re-runs `effectiveForMission` at fetch time, so a revoked agent
contract or denied executor fails closed — a secret grant *never* expands
P12 authority (I1, test P). Conversely cost/secret governance can only deny —
they never make an unroutable executor/model/provider routable (I12; routing
and `assertAgentExecutionAllowed` unchanged).

## 15. Provider/model/route interaction

`model_entry.cost_metadata` was not overloaded into a ledger; a dedicated
`cost_profile` entity references route/model/executor refs. Profiles are
data, not authority — they price or leave billing UNKNOWN; they never promote
routes or models (I12, §32).

## 16. Fail-closed matrix (§35)

| Situation | Result |
|---|---|
| hard policy + METERED_API unbounded | `FAIL_CLOSED_COST_UNBOUNDED` |
| hard policy + UNKNOWN billing | `FAIL_CLOSED_COST_UNKNOWN` |
| usage ≥ hard cap | `FAIL_CLOSED_COST_BUDGET_EXCEEDED` (+event+evidence) |
| PAIR_COST_HALT set/file present, cost-bearing dispatch | `FAIL_CLOSED_COST_HALT` |
| non-USD currency | `FAIL_CLOSED_COST_CURRENCY` |
| reservation CAS conflict | loser adopts canonical row |
| unknown mission/task/cross-mission fetch | `FAIL_CLOSED_*` + audit |
| ref not pinned / pin tampered / digest mismatch | deny + audit |
| policy revoked / narrowed | deny + audit |
| secret policy CAS conflict | `FAIL_CLOSED_VERSION_CONFLICT` |
| unknown/ambiguous state | DENY/HELD, never proceed |

## 17. Concurrency model

- Budget check+reserve runs inside `store.immediate()` (`BEGIN IMMEDIATE`):
  settled+COMMITTED+HELD+requested ≤ hard cap in one txn; loser throws —
  overspend impossible even under workers (R1: two workers race the last
  capacity — exactly one wins, one `FAIL_CLOSED_COST_BUDGET_EXCEEDED`, one
  reservation row).
- Reservation transitions are single-row CAS (`transitionIfCurrent`);
  concurrent settle/reconcile converge on one row (R2).
- Secret policy update is CAS (R3: two workers → one OK, one
  `FAIL_CLOSED_VERSION_CONFLICT`).
- Recovery derives from canonical evidence only — workers' reconcile stacks
  all converge without a second external dispatch.

## 18. Secret leakage test (§30)

Sentinel `P13_SENTINEL_DO_NOT_LEAK_<random>` is installed in the vault and
released once via the full authorized path. Assertions: the string appears
only in `vault.json` and the release response; it appears in **no** canonical
entity, event, governed evidence row, reservation, or `/api/cost` JSON
(test O scans all of them). `assertSecretFree` in `store.put` additionally
hard-blocks any entity payload containing a vault value.

## 19. Test evidence

`src/__tests__/pair-p13.test.ts` — **36 tests**, covering:

- Cost: A lifecycle HELD→COMMITTED→SETTLED via collect_execution_result
  actual_microusd; B business isolation; C stacked scopes
  business/department/agent/mission; D hard cap deny; F warning threshold
  evidence; G unbounded+hard → UNBOUNDED; G2 UNKNOWN+hard → UNKNOWN;
  H subscription unpriced; I historical EXECUTION_PERSISTED reconcile only;
  J crash-HELD recovery; K proven-no-dispatch RELEASED; L ambiguous stays
  HELD; M unknown actual → COMMITTED/ACTUAL_USAGE_UNKNOWN; N committed
  counts reserved; §18 halt env/file blocks cost-bearing only.
- Secret: A grant; B NOT_PINNED; C/D/E mission/task/membership denials;
  F cross-business; G pinned agent allow-list; H executor allow-set;
  J revocation; K late policy unpinned; K2 pinned snapshot vs later widening;
  L new mission pin; M vault absent → 404+audit; O sentinel scan; P P12 deny
  boundary; integrity: pin tamper, stale CAS, project scope.
- Worker races: R1 last-capacity reservation, R2 crash-reconcile convergence,
  R3 secret-policy CAS — genuine `worker_threads` on a shared sqlite file via
  an esbuilt bundle + SharedArrayBuffer barrier.

## 20. Node 20 / Node 22 results

- Node 22.23.3 `pnpm test`: **1892 pass / 2 fail / 24 skip** — the 2 failures
  are the documented pre-existing environment-dependent p5 executor probes
  (dsh/codex binaries present on this dev box); unchanged from the P12
  baseline shape (baseline 1856+36 new).
- Node 20.20.2 `npx vitest run`: **1894 pass / 0 fail / 24 skip** (after an
  ABI rebuild of better-sqlite3@11.10.0; the .node binary was rebuilt per
  Node ABI both ways).

## 21. Security/audit results

`pnpm audit --audit-level=high`: **0 high / 0 critical** (9 vulnerabilities
remain at low/moderate — unchanged dependency posture). No secrets committed;
sentinel only exists in test-local vault + response. `/api/cost` and policy
endpoints expose metadata only — no secret material.

## 22. Integrity results

`PairEvidenceStore.verifyIntegrity` clean after every suite block (asserted
in test O and across P11/P12 suites). No row is mutated without CAS; all
entities carry schema + version.

## 23. Known limitations

- USD pricing accuracy depends entirely on operator-supplied `cost_profile`
  provenance — there is deliberately no live vendor pricing fetch.
- COMMITTED reservations with truly unknowable actual usage hold reserved_max
  against the budget (never under-count) until `settle` is called.
- FREE/UNMETERED dispatches proceed during cost halt; METERED_API/UNKNOWN are
  blocked (documented §18 scope of the halt).
- Department-scope policy requires ≥1 org_agent carrying the department tag
  in that business.
- The 2 pre-existing p5 probe env failures persist (environment binaries, not
  code).

## 24. Explicit P14/P15 non-scope

No workforce scheduler, agent inbox/heartbeat, self-claim, peer delegation,
task graph, reviewer workforce (P14). No CEO agent, objective generation, KPI
loop, strategy/planning loop (P15). No Brain layer, ReasoningBrief, Brain
Model Router, strategic memory. No payments/crypto. No Vault/KMS clone —
existing CredentialBroker vault reused.

## 25. Final classification

**`P13_IMPLEMENTED_PENDING_AUDIT`** — pushed to the NEW P13 branch/PR;
DO NOT MERGE; DO NOT START P14/P15.

---

# REMEDIATION R1 — independent-audit hardening

Audited head `1b51e18` was classified **P13_BLOCKED** with six blockers and two
hardening requirements. R1 remediates all of them on the same PR; every
remediation is fail-closed and preserves P11/P12 PASS semantics.

## R1.1 §1 blocker — cost retry authority gap

**Defect.** `assertAndReserve` adopted a RELEASED (proven no-dispatch) row and
even a HELD row by idempotency BEFORE running halt/billing/policy checks — a
retry after failure bypassed the current authority entirely.

**Fix.** The reservation row is now classified up front:

- COMMITTED/SETTLED → proven historical charge → adopted (no new authority —
  it is not a new dispatch).
- HELD → ambiguous leftover → audited
  `FAIL_CLOSED_COST_RESERVATION_AMBIGUOUS`; it is never authority.
- absent or RELEASED → the FULL current decision re-runs: halt check →
  billing resolution → hard-policy unbounded check → atomic cap
  evaluation inside `store.immediate()`. A RELEASED row is re-held in the
  SAME transaction (CAS on the in-txn version); a concurrent commit races
  to COMMITTED/SETTLED → adopted; anything else → ambiguous → audited
  fail-closed throw.

Consequences: a halt raised after a failed attempt blocks the retry
(FAIL_CLOSED_COST_HALT, 0 dispatches); a tightened cap blocks it
(FAIL_CLOSED_COST_BUDGET_EXCEEDED); re-pricing always reads the CURRENT
profile; an ambiguous HELD can never mint authority.

## R1.2 §2 blocker — pricing pinned into the reservation

**Defect.** The reservation stored only `cost_profile_id`; settlement read the
CURRENT mutable profile row — a later price change rewrote history.

**Fix.** At authorization time the reservation now pins:
`cost_profile_id` + `cost_profile_version` + `cost_profile_digest` +
`billing_mode` + `profile_fixed/input/output/reserve_microusd` +
`currency=USD` + `pricing_source` + `pricing_effective_at`.
`settleFromResult` settles token-metered usage from the PINNED snapshot only,
after re-verifying the pinned digest — a digest mismatch degrades to
COMMITTED/ACTUAL_USAGE_UNKNOWN (never under-count), never to the mutable
profile. Also `reserve_microusd=0`/`fixed_microusd=0` no longer fake-bound a
metered call: bounded requires `reserve>0` OR an explicitly stated fixed fee
with no positive rates; an all-null/zero-supplied metered schedule stays
UNBOUNDED and fails closed under a hard policy.

## R1.3 §3 blocker — executor/route binding required at release

**Fix.** `authorizeCredentialFetch` now requires canonical
`task.selected_executor` and task status ROUTED|RUNNING —
missing → audited `FAIL_CLOSED_SECRET_EXECUTOR_UNBOUND`. Inside
`authorizeRelease`, a route-scoped release on an unbound route →
`FAIL_CLOSED_SECRET_ROUTE_UNBOUND`; a contract hard route restriction with
no route binding → the same. The broker request carries ids only and can
never supply routing identity.

## R1.4 §4 blocker — full P12 narrowing at release

**Fix.** A release is a NEW authority decision: the complete effective
executor authority is re-evaluated at fetch time —
`allowed_executor_ids ∩ restricted_executor_ids − denied_executor_ids` and
`denied_route_ids` / `restricted_route_ids` (when a route is bound) from
`agentContracts.effectiveForMission` (pinned ∩ current). Contract tightening
after routing now revokes future releases.

## R1.5 §5 blocker — business/project isolation at pin

**Fix.** `startMission` resolves `metadata.business_id` to the canonical
`business` row (`FAIL_CLOSED_SECRET_BUSINESS_UNKNOWN`), requires
`business.project_id === mission.project_id`
(`FAIL_CLOSED_SECRET_CROSS_BUSINESS`), and requires the bound org_agent to
belong to that business (`FAIL_CLOSED_SECRET_AGENT_REF`). A forged
`metadata.business_id` can no longer mint BUSINESS_A grants on a BUSINESS_B
project.

## R1.6 §6 blocker — API control fields split from strict payloads

**Fix.** The `/api/*/update` endpoints now destructure control fields
(`policy_id`, `cost_policy_id`, `expected_version`) away from the payload
before strict validation; `expected_version` is required (400 otherwise).
New service-level `updateCostPolicy` / `updateCostProfile` resolve the
canonical identity and fail `FAIL_CLOSED_COST_*_NOT_FOUND` when it doesn't
exist — an update can never silently create.

## R1.7 §7+§8 — purpose + reference validation

- `allowed_purpose`: no canonical purpose subject exists → non-null rejected
  at create AND update with `FAIL_CLOSED_SECRET_PURPOSE_UNSUPPORTED`
  (mandate option B).
- `assertAllowSetRefs`: every allowed_agent_ids id must exist and belong to
  the business (`FAIL_CLOSED_SECRET_AGENT_REF`); allowed_project_ids must be
  the business' canonical `project_id` (`FAIL_CLOSED_SECRET_PROJECT_REF`);
  executor ids must be `PAIR_NATIVE` or a real executor
  (`FAIL_CLOSED_SECRET_EXECUTOR_REF`); route ids must exist
  (`FAIL_CLOSED_SECRET_ROUTE_REF`).

## R1.8 R1 test matrix (12 new tests, 48 total)

- COST-R1-A: RELEASED + halt → retry FAIL_CLOSED_COST_HALT, 0 dispatch.
- COST-R1-B: RELEASED + tightened cap → FAIL_CLOSED_COST_BUDGET_EXCEEDED.
- COST-R1-C: ambiguous HELD → FAIL_CLOSED_COST_RESERVATION_AMBIGUOUS.
- COST-R1-D: V1 dispatch → V2 profile update → settlement prices the V1 pin.
- COST-R1-E: METERED_API zero-supplied bound + hard policy → UNBOUNDED.
- SECRET-R1-A: unbound task → EXECUTOR_UNBOUND + audited.
- SECRET-R1-B: contract allowed_executor_ids tightened → denied.
- SECRET-R1-C: hard executor restriction excludes bound executor → denied.
- SECRET-R1-D: denied route / route allow-set on unbound route → denied.
- SECRET-R1-E: forged business_id on another project + unknown business →
  fail closed at startMission.
- PURPOSE-R1: create + update reject non-null allowed_purpose.
- API-R1: valid updates with expected_version pass; stale CAS → 409;
  unknown payload field → 409; nonexistent id → no silent create.

## R1.9 Validation evidence

- `pnpm run typecheck` PASS · `pnpm run build` PASS
- P13 suite **48/48** · P12 **71/71** · P11 **103/103** · P9 **79/79**
- Node 22.23.3 full `pnpm test`: **1904 pass / 2 fail / 24 skip** — the 2
  fails are the same documented env-dependent p5 executor probes.
- Node 20.20.2 `npx vitest run`: **1906 pass / 0 fail / 24 skip**
  (better-sqlite3@11.10.0 ABI rebuilt both ways).
- `pnpm audit --audit-level=high`: **0 high / 0 critical**.
- Worker races PASS: last-cap reservation, crash-reconcile convergence,
  secret-policy CAS (all rerun under R1 code).
- `verifyIntegrity` clean; no test weakened — two pre-existing P9/P11 tests
  updated only to encode the stricter fail-closed semantics (bound task for
  release; forged business_id now throws at start).

## R1.10 Classification

**`P13_REMEDIATED_R1_PENDING_AUDIT`** — pushed to the existing P13 PR;
DO NOT MERGE; DO NOT START P14/P15.

---

# REMEDIATION R2 — dispatch/cost crash-gap + unknown-cost hard-cap closure

Audited head `a364467` was classified **P13_BLOCKED** with three findings:
the COMMITTED crash gap, UNKNOWN billing under a hard cap, and the
`fixed_microusd=0` fake-bound. R2 remediates all three on the same PR.

## R2.1 §1 critical — COMMITTED crash gap must never redispatch

**Defect.** The post-dispatch ordering was:

`adapter.dispatch()` → `cost.markCommitted()` → persist
`executor_execution` → persist intent `EXECUTION_PERSISTED`

A crash after the commit but before the execution row made durable left
`INTENT_RECORDED + COMMITTED + no evidence`: the retry fell through to the
new-dispatch path, `assertAndReserve` adopted the COMMITTED row, and
`adapter.dispatch` ran a second time — an exactly-once violation.

**Fix (two layers).**

1. **Durable ordering** — `executor_execution` is persisted FIRST, the
   intent is promoted to `EXECUTION_PERSISTED` SECOND, dispatch
   event/evidence THIRD, and `cost.markCommitted` runs LAST. A crash after
   `adapter.dispatch` but before the commit leaves `HELD +
   INTENT_RECORDED` — ambiguous and recoverable (reconcile only from
   canonical adapter evidence), never a license to redispatch.
2. **Defensive gate** — even if a COMMITTED/SETTLED reservation exists
   under `INTENT_RECORDED` (legacy state, partial write), the new-dispatch
   path now fails closed with audited
   `FAIL_CLOSED_COST_COMMITTED_EXECUTION_UNRESOLVED` BEFORE
   `assertAgentExecutionAllowed`/`assertAndReserve`. A cost reservation is
   never treated as execution identity: COMMITTED proves possible
   monetary history, not a reconstructable execution_id.

`assertAndReserve` still returns the existing COMMITTED/SETTLED row
unchanged — but it is now only reachable after an execution row + intent
prove history (EXECUTION_PERSISTED early return, evidence-reconciled
intent), never for a fresh `adapter.dispatch`.

## R2.2 §2 — UNKNOWN billing + hard policy → FAIL_CLOSED_COST_UNKNOWN

**Fix.** When ≥1 applicable HARD monetary policy exists and billing is
`UNKNOWN`, dispatch fails closed with `FAIL_CLOSED_COST_UNKNOWN` — UNKNOWN
may be a paid external route, so a hard cap requires a known cost shape.
Without a hard policy, UNKNOWN remains explicitly unpriced
(`reserved_microusd=0`, `unbounded=true`) — backward compatible.

## R2.3 §3 — `fixed_microusd=0` is not a bound

**Fix.** For METERED_API, bounded now requires `reserve_microusd>0` OR a
positive `fixed_microusd` with no positive variable rates. An explicit
`fixed_microusd=0` (or absent) with no rates stays UNBOUNDED and fails
closed under a hard policy — a genuinely free route belongs under
FREE/UNMETERED.

## R2.4 R2 test matrix (4 new tests, P13 now 52)

- COST-R2-A: INTENT_RECORDED + COMMITTED + no execution row + no evidence
  → `FAIL_CLOSED_COST_COMMITTED_EXECUTION_UNRESOLVED`; 0 retry dispatches;
  reservation stays COMMITTED; intent stays INTENT_RECORDED; no fake
  execution row; verifyIntegrity clean.
- COST-R2-A2: normal dispatch under the new ordering persists
  execution + EXECUTION_PERSISTED before COMMIT; idempotent redispatch
  returns the same execution with `dispatched` count 1.
- COST-R2-B: UNKNOWN + hard business policy → `FAIL_CLOSED_COST_UNKNOWN`;
  zero dispatch, zero reservations.
- COST-R2-C: METERED_API `fixed=0`/no reserve/no rates + hard policy →
  `FAIL_CLOSED_COST_UNBOUNDED`; positive fixed without rates remains
  bounded (reserve = fixed).
- Existing G2 updated (not weakened) to the new UNKNOWN semantics:
  hard → UNKNOWN denied; warning-only → unpriced allowed.

## R2.5 Validation evidence

- `pnpm run typecheck` PASS · `pnpm run build` PASS
- P13 **52/52** · P12 **71/71** · P11 **103/103** · P9 **79/79**
- Node 22.23.3 `pnpm test`: **1908 pass / 2 fail / 24 skip** — same two
  documented env-dependent p5 executor probes.
- Node 20.20.2 `npx vitest run`: **1910 pass / 0 fail / 24 skip**
  (better-sqlite3@11.10.0 ABI rebuilt per Node both ways).
- `pnpm audit --audit-level=high`: **0 high / 0 critical**.
- Worker races PASS: cost last-cap, cost recovery convergence, secret
  CAS, plus all P11/P12 concurrency tests.
- `verifyIntegrity` clean (asserted inside COST-R2-A).

## R2.6 Classification

**`P13_REMEDIATED_R2_PENDING_AUDIT`** — pushed to the existing P13 PR;
DO NOT MERGE; DO NOT START P14/P15.

---

# REMEDIATION R3 — canonical business context + task-scoped broker capability + create/update CAS closure

R3 closes three findings on the existing PR: caller-influenced business
scope, the cross-task bearer broker token, and upsert semantics on the
create endpoints.

## R3.1 §1 — canonical business context

**Defect.** CostService derived business_id/department/org_agent_id from
caller-writable `mission.metadata`. An agent-bound mission could omit
business_id (escaping every business-scoped cap) or forge department
(escaping department caps).

**Fix.** `startMission` resolves the canonical `org_agent` row first:
`business_id` and `department` are taken from the agent, supplied values
must match exactly (`FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH`), and a
missing business_id inherits the agent's business — never "no business
budget". The resolved context is pinned immutably as
`mission.metadata.business_context = {business_id, org_agent_id,
department, project_id, provenance, pinned_at}`, and the pre-existing
business-exists + project-match + agent-membership checks run against it.
`CostService.assertAndReserve` consumes the pinned `business_context`
(falling back to legacy metadata fields only for pre-pin missions);
non-business missions without any binding are preserved.

## R3.2 §2 — task-scoped broker capability

**Defect.** `DevinExecutor` injected the global `PAIR_BROKER_TOKEN` into
every task prompt; `/api/broker/fetch` verified the token but not that the
caller owned the supplied mission/task ids — mission/task ids are not
secrets.

**Fix.** New `broker-capability.ts`: `mintBrokerCapability` /
`verifyBrokerCapability` issue `bcap1.<payload>.<hmac-sha256>` claims
bound to `{mission_id, task_id, governed_task_id, executor_id,
issued_at}`, keyed on the master `PAIR_BROKER_TOKEN`. The executor mints
server-side at prompt-build time; only the capability reaches the remote
worker. `/api/broker/fetch` now requires `x-broker-capability`;
`MissionControl.authorizeBrokerFetch` verifies the signature, binds
claims to body ids + the canonical `selected_executor` + (when one
exists) the exact `governed_task_id`, then runs the unchanged
authorizeCredentialFetch policy chain — a capability never expands secret
policy or P12 authority. Master token alone → 403
`UNAUTHORIZED_BROKER_CAPABILITY`. The capability is never persisted in
the PairEvidenceStore (sentinel scan covers it). No expiry claim —
restart/recovery semantics stay deterministic; revocation rides the
existing policy checks.

## R3.3 §3 — create endpoints are create-only

`POST /api/cost-policies` → `createCostPolicy`
(`FAIL_CLOSED_COST_POLICY_EXISTS` when `cost_policy_id` collides) and
`POST /api/cost-profiles` → `createCostProfile`
(`FAIL_CLOSED_COST_PROFILE_EXISTS` when the deterministic
`(ref_type, ref_id)` identity exists, pointing callers at the CAS
`/update` path). Updates still require `expected_version` →
`FAIL_CLOSED_VERSION_CONFLICT` on stale writes; strict field validation
unchanged.

## R3.4 R3 test matrix (6 new tests, P13 now 58)

- COST-R3-A: agent-bound mission without `business_id` → pinned
  `business_context.business_id` = agent's business; the business hard
  cap applies and denies dispatch.
- COST-R3-B: `department: "marketing"` vs agent `engineering` →
  `FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH`; matching dept accepted and
  canonicalized.
- COST-R3-C: supplied business ≠ agent business, and canonical-business
  project ≠ mission project → fail closed; unbound mission still works.
- SECRET-R3-A..D: scoped capability release PASS; cross-task capability
  → `FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH`; wrong executor →
  `FAIL_CLOSED_BROKER_CAPABILITY_EXECUTOR`; tampered token →
  `FAIL_CLOSED_BROKER_CAPABILITY`; master token alone → 403.
- SECRET-R3-E: sentinel/capability/master scan of entities + evidence +
  events — nothing leaks; `verifyIntegrity` clean.
- API-R3: profile create PASS → duplicate identity 409
  `FAIL_CLOSED_COST_PROFILE_EXISTS` (row unchanged); policy create with
  existing `cost_policy_id` → `FAIL_CLOSED_COST_POLICY_EXISTS`; CAS
  update PASS; stale second writer → `FAIL_CLOSED_VERSION_CONFLICT`.
- Existing p9/p11 broker-fetch tests updated to mint capabilities (the
  auth model changed intentionally; coverage preserved: unknown mission
  → 404, MC bearer/master token → 403, legit release → 200).

## R3.5 Validation evidence

- `pnpm run typecheck` PASS · `pnpm run build` PASS
- P13 **58/58** · P12 **71/71** · P11 **103/103** · P9 **79/79**
- Node 22.23.3 `pnpm test`: **1914 pass / 2 fail / 24 skip** — same two
  documented env-dependent p5 executor probes.
- Node 20.20.2 `npx vitest run`: **1916 pass / 0 fail / 24 skip**
  (better-sqlite3@11.10.0 ABI rebuilt per Node both ways).
- `pnpm audit --audit-level=high`: **0 high / 0 critical**.
- Worker races PASS: cost last-cap, cost recovery convergence, secret
  CAS, all P11/P12 concurrency tests.
- `verifyIntegrity` clean (asserted inside SECRET-R3-E).

## R3.6 Classification

**`P13_REMEDIATED_R3_PENDING_AUDIT`** — pushed to the existing P13 PR;
DO NOT MERGE; DO NOT START P14/P15.

---

# REMEDIATION R4 — canonical secret non-persistence + atomic create-only closure

R4 closes the two remaining findings on the existing PR.

## R4.1 §1 — untrusted remote output can no longer persist broker material

**Defect.** `adapter.collect_result()` output (and `observe()` text) flowed
into `executor_execution.result` / `last_observation` verbatim. A remote
worker echoing its scoped `bcap1.*` capability, the master token, or a
broker-released credential value could plant that material into canonical
entities/evidence/events — prompt instructions were the only guard.

**Fix — deterministic sanitization boundary + defense-in-depth.**

- New `src/pair/sanitizer.ts`: `sanitizeUntrustedRemote` deep-walks
  untrusted values and rewrites `bcap1.<payload>.<sig>` →
  `[REDACTED:BROKER_CAPABILITY]` and any registered sensitive string →
  `[REDACTED:SECRET_MATERIAL]`; `registerSensitiveMaterial` (a runtime,
  never-persisted set) is fed at the producing boundaries:
  `mintBrokerCapability` registers the minted token AND the master
  secret; `CredentialBroker.upsert`/`release` register vault/released
  values; `authorizeBrokerFetch` re-registers the master secret.
- `GovernedTaskGate.collect_execution_result` sanitizes the adapter
  result before `execution.result` — settlement uses the sanitized value
  (usage figures are numbers, unaffected); `observe_execution` sanitizes
  `last_observation`. When redactions occur, `REMOTE_RESULT_REDACTED`
  evidence is appended carrying counts only — never the value.
- Store layer: `PairEvidenceStore.assertSecretFree` now also hard-fails
  any raw `bcap1.*` string in payloads (`FAIL_CLOSED_SENSITIVE_MATERIAL`)
  — entities AND evidence were already covered; `store.event()` now scans
  metadata + state fields too. Nothing canonical legitimately contains a
  capability, so this is a strict fail-closed backstop.

## R4.2 §2 — create-only cost authority is atomic

**Defect.** `createCostProfile()` did `tryGet(identity)` →
`upsertCostProfile()`: a racing second creator could pass the existence
check, then its upsert read the winner's committed version and updated
the winner's row — a create race became an unchecked update.

**Fix.** Both `createCostProfile` and `createCostPolicy` now run inside
`store.immediate()` and write with `expectedVersion = 0` — INSERT-only
enforced at the CAS boundary (`INSERT ... ON CONFLICT DO NOTHING` plus
the serialized transaction). A racer's commit surfaces as
`FAIL_CLOSED_VERSION_CONFLICT` → rethrown as
`FAIL_CLOSED_COST_{PROFILE,POLICY}_EXISTS`; a losing create can never
mutate the winner's row. A caller-supplied `cost_policy_id` is now THE
create identity, honored exactly (previously a novel supplied id was
silently replaced by a generated `CPO_*`); UPDATE remains the separate
CAS path (`/update` + `expected_version` → `FAIL_CLOSED_VERSION_CONFLICT`).

## R4.3 R4 test matrix (4 new tests, P13 now 62)

- SANITIZE-R4-A: legit scoped fetch PASS; worker result echoing
  capability + `master-secret` + released `SENTINEL` through the real
  collect path → canonical dump (missions/tasks/governed/executions/
  intents/reservations/evidence/events) contains none of them;
  `[REDACTED:*]` markers present; `REMOTE_RESULT_REDACTED` audited with
  counts only; post-dispatch capability reminted with the real
  governed_task_id still authorizes; `verifyIntegrity` clean.
- SANITIZE-R4-B: direct `store.put` / `appendEvidence` / `store.event`
  carrying a raw `bcap1.*` → `FAIL_CLOSED_SENSITIVE_MATERIAL`.
- CREATE-R4-A: 4-connection worker race on `createCostProfile` — exactly
  one winner, 3 × `FAIL_CLOSED_COST_PROFILE_EXISTS`, winner row unchanged
  (version 1, payload intact); sequential dup create also fails closed.
- CREATE-R4-B: 3-connection worker race on a supplied `cost_policy_id` —
  exactly one winner at that exact id; a fresh supplied id is honored.

## R4.4 Validation evidence

- `pnpm run typecheck` PASS · `pnpm run build` PASS
- P13 **62/62** · P12 **71/71** · P11 **103/103** · P9 **79/79**
- Node 22.23.3 `pnpm test`: **1918 pass / 2 fail / 24 skip** — same two
  documented env-dependent p5 executor probes.
- Node 20.20.2 `npx vitest run`: **1920 pass / 0 fail / 24 skip**.
- `pnpm audit --audit-level=high`: **0 high / 0 critical**.
- Worker races PASS: cost last-cap, recovery, secret CAS, P11/P12 races,
  + new create-only races (profile ×4, policy ×3).
- `verifyIntegrity` clean.

## R4.5 Classification

**`P13_REMEDIATED_R4_PENDING_AUDIT`** — pushed to the existing P13 PR;
DO NOT MERGE; DO NOT START P14/P15.

---

# REMEDIATION R5 — restart-durable secret non-persistence + minimum credential length

## R5.1 §1 — restart-durable registration

**Defect.** The sensitive-material registry was process-memory only.
`upsert()`/`release()` registered values, but a restart left the Set
empty — a credential released before the crash could then be echoed by
a stale remote worker straight into `executor_execution.result`.

**Fix.** `CredentialBroker`'s constructor now `load()`s the existing
vault and registers every installed credential value at startup —
restart-durable by construction, before any new release/upsert. Vault
file remains the only persistence; values still never enter canonical
state, events, evidence, logs or audit metadata.

## R5.2 §2 — short-credential gap closed (policy B)

The broker now owns a documented minimum value length:
`MIN_CREDENTIAL_VALUE_LENGTH = 8` — the sanitizer protection threshold.
`upsert()` rejects shorter values
(`FAIL_CLOSED_CREDENTIAL_VALUE_TOO_SHORT`); `load()` validates installed
values and fails closed the same way, so a legacy short credential can
never slip under sanitizer coverage. An accepted credential can never
be one the non-persistence layer ignores. Existing test fixtures using
4-char values were updated to >= 8 (intentional semantic change).

## R5.3 R5 test matrix (2 new tests, P13 now 64)

- RESTART-R5 (real worker_threads isolation): vault written directly to
  disk simulating a previous process; a FRESH worker (empty module
  registry → empty Set) constructs `CredentialBroker` on that vault —
  no upsert/release — then drives the real `collect_execution_result`
  path with hostile output echoing the credential. Canonical dump
  (executor_execution/mission/task/governed/evidence/events) contains
  no raw value, carries `[REDACTED:SECRET_MATERIAL]` and the
  count-only `REMOTE_RESULT_REDACTED` audit; `verifyIntegrity` clean.
- SHORT-R5: install of a 7-char value →
  `FAIL_CLOSED_CREDENTIAL_VALUE_TOO_SHORT`; an exactly-8-char value is
  accepted and sanitizer-redacted on echo; a legacy vault with a
  sub-minimum value fails closed at `load()`/ctor.

## R5.4 Validation evidence

- `pnpm run typecheck` PASS · `pnpm run build` PASS
- P13 **64/64** · P12 **71/71** · P11 **103/103** · P9 **79/79**
- Node 22.23.3 `pnpm test`: **1920 pass / 2 fail / 24 skip** — same two
  documented env-dependent p5 executor probes.
- Node 20.20.2 `npx vitest run`: **1922 pass / 0 fail / 24 skip**.
- `pnpm audit --audit-level=high`: **0 high / 0 critical**.
- Worker races PASS: all prior races incl. R4 create-only races.
- `verifyIntegrity` clean.

## R5.5 Classification

**`P13_REMEDIATED_R5_PENDING_AUDIT`** — pushed to the existing P13 PR;
DO NOT MERGE; DO NOT START P14/P15.

---

# REMEDIATION R6 — durable historical redaction + fail-closed vault load

## R6.1 §1 — retired credentials remain redaction-protected

**Defect.** R5 registered only values currently in `vault.json`. Rotate or
delete a credential and its old value vanished from the vault — a stale
remote session echoing it after a PAIR restart would then land raw in
`executor_execution.result`.

**Fix.** The vault schema is now `{ credentials: {...}, retired: [...] }`.
`upsert()` over an existing name and `remove()` both retire the old value
into `retired` — redaction-only material inside the SAME non-canonical
vault boundary (no second secret store). The constructor registers
**active + retired** values at startup, so every credential that may
still exist in an outstanding remote execution keeps sanitizer
protection across rotation, deletion, and restart. Retired values are
never returned by `release()` or `list()` — the current credential stays
normally releasable.

## R6.2 §2 — vault load fails closed

`load()` previously returned `{}` on any generic read/parse failure —
fail-open: startup could proceed with an empty sanitizer registry. Now a
missing vault is still created fresh, but malformed JSON, a malformed
credential record, an invalid `retired` record, or any inconsistent
shape throws `FAIL_CLOSED_CREDENTIAL_VAULT_INVALID` (names only in error
detail, never values). `FAIL_CLOSED_CREDENTIAL_VALUE_TOO_SHORT`
semantics for sub-8 values are preserved for active and retired records.

## R6.3 R6 test matrix (3 new tests, P13 now 67)

- ROTATE-R6 (worker_threads isolation): worker A installs SECRET_OLD and
  rotates to SECRET_NEW, exits; fresh worker B (empty module registry)
  constructs `CredentialBroker` on the resulting vault — no
  upsert/release — collects a hostile echo of SECRET_OLD through
  `collect_execution_result`. Canonical dump contains no raw value,
  shows `[REDACTED:SECRET_MATERIAL]`; `release("api")` returns SECRET_NEW
  (never SECRET_OLD); `verifyIntegrity` clean.
- DELETE-R6: same flow with `remove()`; echo of SECRET_DELETE is
  redacted; `release("api") === null`.
- VAULT-INVALID-R6: malformed JSON, malformed credential record, invalid
  retired record, wrong top-level shape → `FAIL_CLOSED_CREDENTIAL_VAULT_INVALID`
  at construction.

## R6.4 Validation evidence

- `pnpm run typecheck` PASS · `pnpm run build` PASS
- P13 **67/67** · P12 **71/71** · P11 **103/103** · P9 **79/79**
- Node 22.23.3 `pnpm test`: **1923 pass / 2 fail / 24 skip** — same two
  documented env-dependent p5 executor probes.
- Node 20.20.2 `npx vitest run`: **1925 pass / 0 fail / 24 skip**.
- `pnpm audit --audit-level=high`: **0 high / 0 critical**.
- Worker races PASS incl. R4 create-only + R5/R6 restart races.
- `verifyIntegrity` clean.

## R6.5 Classification

**`P13_OFFICIAL_FINAL_PASS`**

- Merged PR: `#6`
- Independently audited R6 head: `6e01b061439cba16ae78b775a464713a9152728a`
- Canonical P13 merge / `main` authority: `916a0b92b2e8e122eb7e4e7e76ae36962add21d1`
- Independent audit result: `P13_R6_INDEPENDENT_AUDIT_PASS`
