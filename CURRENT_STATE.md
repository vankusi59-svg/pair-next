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

## Not yet

- Token/USD cost ledger + scoped credential capabilities (P13),
  autonomous heartbeat/inbox/delegation (P14), CEO agent / KPI gap
  analysis (P15). Intentionally deferred.

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
