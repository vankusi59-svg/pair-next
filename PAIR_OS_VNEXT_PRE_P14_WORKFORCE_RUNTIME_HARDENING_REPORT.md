# PAIR NEXT — PRE-P14-WORKFORCE RUNTIME HARDENING REPORT

Classification: `PRE_P14_WORKFORCE_RUNTIME_HARDENING_REMEDIATED_R1_PENDING_AUDIT`

- **Repo**: `vankusi59-svg/pair-next`
- **Base SHA (canonical main)**: `fff2ee4852231cbabed9c084fae61f8497f2acf8` (post-PR-#9 merge)
- **Branch**: `devin/1790726448-pre-p14-runtime-hardening`
- **Head SHA**: recorded in the PR (this file lands on the branch head)
- **Scope**: ONLY the two inherited runtime defects. No Workforce V2, no P15, no P16.
- **R1 remediation**: missing-runtime reconstruction narrowed to the provably-safe case — see §2.

---

## 1. Defect A — `FAIL_CLOSED_MODEL_REMOVED` boot crash-loop

### Root cause

`scripts/serve-mission-control.mjs` route-qualification loop calls
`probeModel(store, model_entry_id, 1, {...})` for every `wanted` DSH route.
`probeModel` (`src/pair/model-probing.ts:77-79`) fail-closes with
`IntegrityError("FAIL_CLOSED_MODEL_REMOVED")` whenever the catalog entry's
`conditions` include `REMOVED` (set by absence reconciliation in
`model-catalog.ts` once `absence_streak` reaches threshold).

That throw is correct for direct callers — a REMOVED model must never be
probed — but in the boot loop it was uncaught, so a persisted catalog
containing any REMOVED entry crashed the server on every restart: a
**durable-state boot crash-loop**.

### Fix

Route qualification now treats REMOVED as a static **NOT ROUTABLE**
property and skips the entry *before* the probe call:

```js
if ((me.conditions ?? []).includes("REMOVED")) {
  console.log("MODEL_ROUTE:", route, "model REMOVED — skipped");
  continue;
}
```

- Boot continues past REMOVED entries.
- Nothing is caught or swallowed — no try/catch was added at all, so
  unrelated `IntegrityError`/`PolicyError` from `validateAccess`,
  `qualify`, or `probeModel` still propagate and fail closed.
- `qualifyModel`'s existing `MODEL_NOT_REMOVED` gate still marks REMOVED
  entries unqualified — double protection against routability.
- `probeModel` itself is unchanged: direct calls on REMOVED entries still
  fail closed (`FAIL_CLOSED_MODEL_REMOVED`).

---

## 2. Defect B — non-terminal mission with missing `mission_runtime`

### Root cause

`startMissionInternal` (`src/pair/mission-control.ts`) persists the mission
row first and calls `runtime.runtimeEntity(mission_id)` afterwards
(~line 615). A crash between those two writes leaves a live (non-terminal)
mission with **no `mission_runtime` row**. `MissionSupervisor.resume()`,
`tick()`, and every sweep discover work only by listing `mission_runtime`
— so the orphan is invisible forever.

### Fix (R1 — safe reconstruction only)

`MissionSupervisor.resume()` scans the canonical `mission` list before
waking and applies the **exact safe reconstruction rule**:

```ts
for (const m of this.store.list("mission")) {
  const status = String(m.status);
  if (TERMINAL_MISSION.has(status)) continue;                     // never resurrect
  if (this.store.tryGet("mission_runtime", `MRT_${m.mission_id}`)) continue;
  if (status === "CREATED") {
    this.runtime.runtimeEntity(String(m.mission_id));             // canonical create
    reconstructed++;
    continue;
  }
  this.persistRuntimeAmbiguity(missionId, status);                // FAIL CLOSED
}
```

- **`CREATED` is the only automatically reconstructable state** — the only
  status provably inside the original crash window. `runtimeEntity` is
  idempotent, version-0 CAS, the same canonical factory used at mission
  start.
- **READY / RUNNING / PAUSED + missing runtime = ambiguous → fail
  closed.** The prior runtime state cannot be inferred from mission
  status (recreating as CREATED could auto-run a mission an operator
  paused, or replay a RUNNING mission's work). `persistRuntimeAmbiguity`
  stamps a durable `restart_blocker` on the canonical
  `mission_recovery_checkpoint` (`MRCP_<id>`, already written by the
  existing `RecoveryController.planRestartRecovery`) with
  `code: FAIL_CLOSED_RUNTIME_AMBIGUOUS` + observed status, and emits a
  `MISSION_RUNTIME_AMBIGUOUS` evidence event. The mission gets **no
  runtime row and no wake** — it can never be ticked, dispatched, or
  silently replayed. PAUSED authority stays in effect; RUNNING/READY
  cannot duplicate work. Operator recovery uses the existing governed
  controls (cancel/block/review). No second recovery engine, no guessed
  runtime state, no automatic replay of uncertain in-flight execution.
- **Unknown/malformed status** (outside the canonical whitelist
  `CREATED|READY|RUNNING|PAUSED` + terminal set) fails closed identically,
  recorded as `UNKNOWN:<status>`.
- **Terminal** (`COMPLETED|FAILED|CANCELLED`): never reconstruct, never
  wake, never resurrect — unchanged.
- `resume()` returns `{ missions, checkpoints, reconstructed }` (extra
  field, backward compatible).

---

## 3. Preserved authority

P14 Foundation V2 (work_open_binding, ADMISSION vs PROVENANCE,
`bound_open_id` sealing, context derivation, collision fail-closed),
P12 contracts, P13 cost/secrets, MissionRouter, GovernedTaskGate,
MissionRuntime, MissionSupervisor, RecoveryController — all unchanged in
behavior. The runtime reconstruction reuses `runtimeEntity`, the same
canonical row factory used by mission start.

---

## 4. Tests

Suite `src/__tests__/pair-runtime-hardening.test.ts` (11, R1-expanded):

| Test | Proof |
|---|---|
| `RH-R1-MODEL-REMOVED-REGRESSION` | Defect A stays closed — REMOVED skipped, `MODEL_NOT_REMOVED` gate fails, direct `probeModel` still throws `FAIL_CLOSED_MODEL_REMOVED` |
| `RH-R1-MODEL-REMOVED-INTEGRITY` | Unrelated `IntegrityError` (`FAIL_CLOSED_PROBE_NOT_CONFIGURED`) propagates — not swallowed |
| `RH-R1-CREATED-RECONSTRUCT` | CREATED orphan → canonical `MRT_*` (state CREATED) + `RESTART_REHYDRATE` wake + `MISSION_RUNTIME_CREATED` evidence |
| `RH-R1-PAUSED-NO-AUTORUN` | PAUSED + missing runtime → no runtime row, no wake, `runUntilSettled()` dispatches nothing, mission stays PAUSED; `restart_blocker` on `MRCP_*` + `MISSION_RUNTIME_AMBIGUOUS` event |
| `RH-R1-RUNNING-NO-GUESS` | RUNNING + missing runtime → no guessed state, no runtime, no duplicate dispatch, blocker evidence |
| `RH-R1-READY-NO-GUESS` | READY + missing runtime → fail closed, blocker evidence |
| `RH-R1-UNKNOWN-STATUS` | Malformed `WIBBLE` status → no reconstruction, blocker records `UNKNOWN:WIBBLE` |
| `RH-R1-TERMINAL` | COMPLETED + FAILED + CANCELLED without runtime → no `MRT_*`, no ambiguity events |
| `RH-R1-IDEMPOTENT` | CREATED orphan, `resume()` ×2 → 1 runtime row, `reconstructed` 1→0, `MISSION_RUNTIME_CREATED` count stable |
| `RH-R1-EXISTING-RUNTIME` | Normally-started mission → version unchanged, single runtime row |
| `RH-R1-GOVERNED-CONTINUATION` | Reconstructed CREATED orphan → `runUntilSettled()` → dispatched once → COMPLETED via governed path |

---

## 5. Validation results

| Suite | Result |
|---|---|
| Focused runtime-hardening (R1) | **11/11** |
| P14 Foundation V2 | **35/35** |
| P13 | **67/67** |
| P12 | **71/71** |
| P11 (base+R1-R6) | **103/103** |
| P9 | **79/79** |
| P10 (runtime/supervisor/recovery) | **31/31** |
| P6 (providers/models) | **36/36** |
| **Node 22 full** | **1969 pass · 2 fail = P5 DSH+CODEX probe env gap (pre-existing, unchanged)** |
| **Node 20 full** | **1971 pass · 0 fail** |
| typecheck (`tsc --noEmit`) | clean |
| build (`npm run build`) | PASS |
| `pnpm audit --audit-level=high` | 0 high / 0 critical (1 low, 8 moderate — unchanged baseline) |
| `verifyIntegrity()` | exercised across P9/P10 suites — clean |

Fresh-server E2E evidence: see the PR comment (kill old servers → checkout
new head → rebuild → fresh server → 409 `FAIL_CLOSED_MISSION_ID_PUBLIC`
probe → REMOVED-catalog boot continuity + orphan-runtime recovery + E2E).

## 6. Known remaining issues

- P5 DSH+CODEX probe tests need `PAIR_DSH_HOME`/`CODEX_HOME` env — env gap,
  unchanged by this work.
- `FAIL_CLOSED_MODEL_REMOVED` still throws on direct `probeModel` calls —
  intended fail-closed behavior, now unreachable from boot because the
  route loop skips REMOVED entries first.
- PR #8 (legacy P14 workforce branch) remains reference-only — now closed;
  it was never a base for this work.
- A restart-orphaned in-flight execution (live `executor_execution` row,
  supervisor restart mid-flight) strands as `UNKNOWN` — the mission parks
  RUNNING and `/reconcile` emits `CONFIRMED_NOT_EXECUTED`/`replay_allowed`
  but does not re-drive. R1 now also fails closed on this case (RUNNING +
  missing runtime → `FAIL_CLOSED_RUNTIME_AMBIGUOUS` blocker, no guessed
  replay). Automatic replay of uncertain in-flight execution is
  intentionally out of scope — operator recovery via existing governed
  controls.
