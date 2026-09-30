# PAIR NEXT — PRE-P14-WORKFORCE RUNTIME HARDENING REPORT

Classification: `PRE_P14_WORKFORCE_RUNTIME_HARDENING_PENDING_AUDIT`

- **Repo**: `vankusi59-svg/pair-next`
- **Base SHA (canonical main)**: `fff2ee4852231cbabed9c084fae61f8497f2acf8` (post-PR-#9 merge)
- **Branch**: `devin/1790726448-pre-p14-runtime-hardening`
- **Head SHA**: recorded in the PR (this file lands on the branch head)
- **Scope**: ONLY the two inherited runtime defects. No Workforce V2, no P15, no P16.

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

### Fix

`MissionSupervisor.resume()` now performs an **orphan scan on the
canonical `mission` list** before waking:

```ts
for (const m of this.store.list("mission")) {
  if (TERMINAL_MISSION.has(String(m.status))) continue;   // never resurrect
  const runtimeId = `MRT_${m.mission_id}`;
  if (this.store.tryGet("mission_runtime", runtimeId)) continue; // preserve existing
  this.runtime.runtimeEntity(String(m.mission_id));              // canonical create
  reconstructed++;
}
```

- `runtimeEntity` is already idempotent and version-0 CAS — the same code
  used at mission start, so reconstructed rows are canonical, not a
  second creation path.
- Terminal missions (`COMPLETED|FAILED|CANCELLED`) are never resurrected.
- Existing valid runtimes are never replaced or duplicated.
- Reconstructed missions join the existing `RESTART_REHYDRATE` wake +
  supervisor tick path — no direct dispatch, no second scheduler/router/
  recovery engine.
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

New suite `src/__tests__/pair-runtime-hardening.test.ts` (7):

| Test | Proof |
|---|---|
| `RUNTIME-HARDENING-MODEL-REMOVED-BOOT` | Persisted REMOVED entry → route guard skips (`SKIPPED_NOT_ROUTABLE`), `qualifyModel` fails `MODEL_NOT_REMOVED`, direct `probeModel` still throws `FAIL_CLOSED_MODEL_REMOVED` |
| `RUNTIME-HARDENING-MODEL-REMOVED-INTEGRITY` | Non-REMOVED model without probeFn → unrelated `IntegrityError` (`FAIL_CLOSED_PROBE_NOT_CONFIGURED`) propagates — not swallowed |
| `RUNTIME-HARDENING-MISSING-RUNTIME` | Orphan non-terminal mission → `resume()` reconstructs `MRT_*` (state CREATED), `RESTART_REHYDRATE` wake + `MISSION_RUNTIME_CREATED` event persisted |
| `RUNTIME-HARDENING-IDEMPOTENT` | `resume()` ×2 → exactly one runtime row, `reconstructed` 1→0, `MISSION_RUNTIME_CREATED` count stable |
| `RUNTIME-HARDENING-TERMINAL` | CANCELLED mission with no runtime → no `MRT_*` row created |
| `RUNTIME-HARDENING-EXISTING-RUNTIME` | Normally-started mission → version unchanged, single runtime row |
| `RUNTIME-HARDENING-GOVERNED-CONTINUATION` | Reconstructed orphan → `supervisor.runUntilSettled()` → scripted executor dispatched once → mission COMPLETED through the existing governed path |

---

## 5. Validation results

| Suite | Result |
|---|---|
| Focused runtime-hardening | **7/7** |
| P14 Foundation V2 | **35/35** |
| P13 | **67/67** |
| P12 | **71/71** |
| P11 (base+R1-R6) | **103/103** |
| P9 | **79/79** |
| P10 (runtime/supervisor/recovery) | **31/31** |
| P6 (providers/models) | **36/36** |
| **Node 22 full** | **1965 pass · 2 fail = P5 DSH+CODEX probe env gap (pre-existing, unchanged)** |
| **Node 20 full** | **1967 pass · 0 fail** |
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
- PR #8 (legacy P14 workforce branch) remains reference-only; it conflicts
  with merged main and is not a base for this work.
