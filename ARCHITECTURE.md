# PAIR Next — Architecture

PAIR Next is a governed mission control plane built on the Conway Automaton
agent codebase. The automaton runtime supplies the agent loop, tools, sandbox
and memory; PAIR wraps it in a canonical, fail-closed pipeline for all work.

## Canonical flow

```
Business Layer → Work Item → MissionControl → Canonical Mission
  → Planner → MissionRouter → GovernedTaskGate → Executor
  → Recovery → Verified Experience → Result
```

Business entities (businesses, org agents, objectives, routines, budgets)
**never dispatch side effects directly**. The only seam into the engine is
`BusinessLayer.openWorkItem` → `MissionControl.startMission`.

## Core modules (`src/pair/`)

| Module | Role |
|---|---|
| `store.ts` (`PairEvidenceStore`) | Canonical SQLite evidence store (WAL). Every entity is hash-verified on read; optimistic version locking (`FAIL_CLOSED_VERSION_CONFLICT`); `assertSecretFree` rejects secret-marker keys; append-only audited event log; `verifyIntegrity()` full scan. |
| `service.ts` (`PairControlPlane`) | Service layer: projects, capabilities, routes, bindings, missions, tasks. |
| `gate.ts` (`GovernedTaskGate`) | Per-task admission control — capability, permission, workspace, policy. |
| `executor-registry.ts` / `adapter.ts` | Executor registration, qualification, capabilities, dispatch contract. |
| `mission-router.ts` (`MissionRouter`) | **Single routing authority** — binds each governed task to one qualified route; consults the verified-experience routing advisor. |
| `mission-runtime.ts` | Executes missions through gate → router → executor; emits execution evidence. |
| `mission-supervisor.ts` / `mission-scheduler.ts` | Mission lifecycle driving + concurrency limits. |
| `recovery-controller.ts` (`RecoveryController`) | Failure classification + governed recovery actions (retry, re-route, escalate → approvals). |
| `reconciliation.ts` | Reconciles remote/executor state back into canonical mission state. |
| `mission-observability.ts` | Metrics + health surfaces. |
| `approval-queue.ts` | Operator approvals (recovery, promotions) — the human gate. |
| `mission-control.ts` (`MissionControl`) | Operator facade: `startMission`, pause/resume/cancel, approvals, schedules, previews. |
| `mission-schedule.ts` | Cron schedules compiled to canonical missions (used by routines). |
| `business.ts` (`BusinessLayer`) | One-person-business layer: `business`, `org_agent`, `objective`, `work_item`, `routine`, `budget_policy` entities; scope isolation per `business_id`; work-item lifecycle with explicit legal-transition map; single-owner claims with expiring `claim_token`; budget hard-stops; routine→schedule→mission→work-item projection. |
| `credential-broker.ts` | Local vault (chmod 600, outside the canonical store) releasing secrets to remote executors via a narrow broker token; every release/denial audited as a canonical event. Releases are verified against a real mission outbox. |
| `experience.ts` / `experience-extraction.ts` / `experience-verifier.ts` / `experience-advisors.ts` | Verified-experience loop: executions → OBSERVATION/ROUTING_PRIOR/FAILURE_SIGNATURE memories → CANDIDATE→QUALIFIED→ACTIVE via verifier → advisory-only routing priors. Experience **never** grants permissions, expands workspace, or bypasses gate/approval. |
| `mission-control-server.ts` | HTTP API + operator auth (`x-operator-id` for writes), business endpoints, broker fetch endpoint (`x-broker-token`, mission-existence verified), outbox. |
| `devin-executor.ts` / `adapter.ts` (`PairNativeExecutorAdapter`) / `dsh-adapter.ts` / `codex-adapter.ts` | Executor adapters: Devin remote sessions, in-process native tasks, DSH model tasks, Codex CLI. |

## Live stack

`scripts/serve-mission-control.mjs` wires everything for the 24/7 stack:

- Server on `:8788` (`Authorization: Bearer $PAIR_MC_TOKEN`; writes need `x-operator-id`).
- Executor registry: NATIVE (in-process), DEVIN (remote sessions), DSH (model tasks), CODEX CLI.
- Model routes probed at boot in priority order: `PAIR_DSH_MODEL_ROUTE` (primary) → `PAIR_DSH_FALLBACK_ROUTE` → `PAIR_DSH_EXTRA_ROUTES` (comma list, unbounded). First qualified route becomes the planner model.
- `BusinessLayer` mounted with schedule service (routines → mission_schedule).
- `CredentialBroker` vault at `$PAIR_MC_DIR/vault.json`.
- Experience sweep folds finished executions into verified memory every 15s.
- Telegram bridge (`scripts/telegram-bridge.mjs`).
- React dashboard `apps/mission-control-ui` reads the same API.

## Invariants (P11)

- **Scope integrity:** every business-scoped reference (assignee, `reports_to`, objective parent, budget scope, routine assignee) must resolve inside the same business — fail closed otherwise.
- **Work-item lifecycle:** legal transitions only (`WORK_ITEM_TRANSITIONS`); terminal `DONE`/`CANCELLED` cannot re-enter except governed reopen via `openWorkItem`.
- **Claim integrity:** single live owner; expired claims reclaimable; a live claim is released only with its `claim_token`; terminal sync releases the claim.
- **Single dispatch:** `openWorkItem` writes `IN_PROGRESS` (+claim) under the optimistic version lock *before* minting the mission — a retry/double-click/concurrent open hits the transition guard, so exactly one governed mission exists per open.
- **Routine projection:** at most one work item per fired mission, deduped by `mission_id`, restart-safe, business-scoped.
- **Budgets:** mission-count model, hard-stop fail-closed (`FAIL_CLOSED_BUDGET_EXCEEDED`), audited `BUDGET_EXCEEDED`, scope IDs validated.
- **Credential broker:** values never enter entities/evidence/events/logs; every release **and** denial audited; mission existence verified.

## Upstream heritage

`src/` retains the Automaton agent runtime (loop, tools, memory, heartbeat,
self-mod) — see `DOCUMENTATION.md` for the upstream reference. PAIR Next's
control plane is the layer above it, and the live stack drives the control
plane, not the free-running agent loop.
