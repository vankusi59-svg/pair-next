# PAIR NEXT — PHASE E PROVIDER / MODEL OPERATIONAL AUTHORITY CLOSURE REPORT

- BASE SHA: `b08e8a552d10c9b0e74c0289a554be2567e9c161` (main, post-PR #28)
- HEAD SHA: see `git rev-parse HEAD` on branch (single commit carrying all §3–§20 work)
- Branch: `devin/1790938483-phase-e`
- PR: this report is attached to the single Phase E PR (see PR description)
- Classification: `PAIR_NEXT_PHASE_E_PROVIDER_MODEL_OPERATIONAL_CLOSURE_PENDING_INDEPENDENT_AUDIT`

## 1. Existing architecture discovered before modification

Read of the pre-change seams (evidence: `src/pair/*.ts` at b08e8a5):

- `ProviderCatalog` (provider-catalog.ts): canonical provider entries
  (`PRV_*`), lifecycle `DISCOVERED→PROBED→QUALIFIED→MODEL_DISCOVERY_ELIGIBLE`,
  `upsertCandidate` field-precedence folding, `recordProbeObservation`,
  `issueQualificationReceipt`, `provider_sources`-style `sources` array,
  `assertSecretSafe` payload guard.
- `ProviderValidator` (provider-validation.ts): `validateAccess` records
  `provider_access_observation` (AUTH_OK/CREDENTIAL_MISSING/AUTH_FAILED/
  UNREACHABLE) + probe-observation detail; `qualify` gates
  (CREDENTIAL_RESOLVABLE, AUTH_ACCEPTABLE, PROTOCOL_PROBED, …).
- `ModelEvidenceCatalog` (model-catalog.ts): canonical model entries keyed
  `canonicalModelId(provider_family, model_id)`, claim folding,
  `issueQualificationReceipt`, `reconcileAbsence` (COMPLETE-only;
  streak→STALE→REMOVED→REAPPEARED), `probeModel` tier-1 evidence.
- `providerModelEligibility` (model-routable.ts): two-channel gate vector —
  availability rejects vs AUTHORITY_GATES throws; `projectRoutableModels`
  joins executor × binding × provider × model.
- `model-discovery.ts` `runModelDiscovery` + `provider-discovery.ts`
  `runProviderDiscovery`: per-run source/adapter scans, model snapshots.
- `dsh-model-router.ts`: per-invocation `assertDshCandidateEligible`
  (AUTHORITY throw / availability reject split), safe failover boundary.
- `dsh-adapter.ts`: `runAttempts` override; unbound-router env path existed
  as a compatibility fallback.
- `model-role.ts`: `resolveConfiguredModelRoleRoute`,
  `reconcileModelRoleAssignments` (atomic desired-state reconcile),
  `assertCanonicalModelRoleStateDisjoint`,
  `assertPlannerCandidateEligible`, AUTHORITY_GATES.
- `scripts/serve-mission-control.mjs`: boot chain — provider discovery →
  validation → model discovery → role reconcile → per-route qualify →
  binding → router bind.
- `sanitizer.ts`: `sanitizeUntrustedRemote`,
  `registerSensitiveMaterial`, redaction token `[REDACTED:SECRET_MATERIAL]`.

## 2. Exact gaps found (and closed)

| § | Gap at b08e8a5 | Closure |
|---|----------------|---------|
| 3 | Boot did `setLifecycle(pid, "MODEL_DISCOVERY_ELIGIBLE")` unconditionally — enumeration minted the resting-state meant to follow qualification | New lifecycle `DISCOVERY_ELIGIBLE`: enumeration-only, NOT in `PROVIDER_OK_STATES`, scanned by `PROVIDER_DISCOVERY_SCAN_STATES`; boot records real `validateAccess` then sets `DISCOVERY_ELIGIBLE` |
| 4 | `AUTH_REQUIRED` / `AUTH_ACCEPTABLE` tolerated non-AUTH_OK states (e.g. CREDENTIAL_MISSING could read as acceptable in some paths) | `AUTH_ACCEPTABLE` requires `AUTH_OK` (or credentialResolvable `AUTH_OK`); `PROVIDER_AUTH_OK` gate = `auth_state==="AUTH_OK"` only; `providerRoutableGate` also blocks DISABLED/UNQUALIFIED/REMOVED |
| 5 | No source-aware provider absence reconciliation — a stale credential source could mark a provider absent while another authority still observed it | `recordProviderSnapshot` (COMPLETE/FAILED rows) + `reconcileProviderAbsence(claimedBySource)` — only providers claimed by a completed source are reconciled; absence-from-all streak→STALE≥1→REMOVED≥3; FAILED source never counts; re-observation → REAPPEARED |
| 6 | Probe failure demotion not uniform | `recordProbeObservation` writes probe_state `PROBE_*` (failure class) vs `PROBED`; `PROVIDER_PROBE_CURRENT` gate fails on `PROBE_*` prefix; no path resurrects auth_state on restart |
| 7 | Receipts had no binding to current material | `issueQualificationReceipt` (provider + model) mints `material_fingerprint` = `providerIdentityDigest`/`modelIdentityDigest`; gates verify fingerprint correspondence |
| 8 | Model identity silently aliased across provider ids | `upsertModelClaim` records `{field:"provider_id",prior,candidate}` into `contradictions[]` — never flips first-seen provider_id; no broad migration performed (none required — no defect demonstrated) |
| 9 | Bindings/fallbacks used `provider_family` where authoritative `provider_id` existed | serve fallback bindings + router eligibility use `m.provider_id ?? m.provider_family` |
| 10 | Model currentness | Existing COMPLETE-only `reconcileAbsence` preserved and proven (D1–D4) |
| 11 | Binding currentness | Orphan/inactive/REMOVED entities surface in `projectRoutableModels` with failing gates, never routable (G1–G4) |
| 12 | `modelRoute` env could act as a raw configured route when canonical eligibility said no | `compatEnvRouteFallback?: boolean` dep — governed dispatch without a bound router throws `FAIL_CLOSED_DSH_MODEL_ROUTER_UNBOUND` unless explicitly opted in (production MC never sets it; test harnesses declare it) |
| 13 | Planner lifecycle work was nested inside `governed.has(DSH_EXECUTOR_ID)` | Planner role-resolution + reconcile + pool qualification moved outside the DSH gate; only DSH pool qualification + fallback bindings + router bind stay gated |
| 14 | Timeout authority | `PAIR_MODEL_DISCOVERY_TIMEOUT_MS` knob (500–120000, default 8000) via `MODEL_DISCOVERY_TIMEOUT` + `modelDiscoveryTimeoutMs()`; `makeDefaultHttpGet(timeoutMs)` factory — single canonical source |
| 15 | External error text could persist credentials | `sanitizeDiagnostic()` = `sanitizeUntrustedRemote` capped at 200 chars on probe-observation detail + provider-discovery errors; `registerSensitiveMaterial` for every declared credential env at boot |
| 16 | Refresh idempotency | Proven (K1/K2): repeated `runProviderDiscovery` + store reopen yield exactly one entry |
| 17 | CAS | `store.put` version-matched writes; stale-version write throws `FAIL_CLOSED_VERSION_CONFLICT` (K3) |
| 18 | Partial failure | Per-source/per-adapter isolation: one failed source → FAILED snapshot, others still COMPLETE; errors recorded per id |
| 19 | MC observability | Gate vector names the exact failing gate (e.g. `CAPABILITY_TEXT_INFERENCE` FAIL observed live); no secret material in projections |
| 20 | R8 invariants | Incident suite 106/106 preserved (see regression) |

## 3. Startup bootstrap authority — before vs after

- **Before**: any discovered provider got `MODEL_DISCOVERY_ELIGIBLE` — the
  same resting state the canonical chain assigns after `qualify()` succeeds —
  so enumeration carried implicit routable-adjacent authority.
- **After**: boot runs `validator.validateAccess(pid)` (records a REAL
  AUTH_OK / CREDENTIAL_MISSING observation) then sets `DISCOVERY_ELIGIBLE`.
  `DISCOVERY_ELIGIBLE` is an enumeration state in
  `PROVIDER_DISCOVERY_SCAN_STATES` (model claims still fold in) but NOT in
  `PROVIDER_OK_STATES` — `PROVIDER_QUALIFIED` fails, `providerRoutableGate`
  fails. `MODEL_DISCOVERY_ELIGIBLE` is now reached only via canonical
  qualification and requires a `provider_qualification` receipt whose
  `material_fingerprint` matches the current `providerIdentityDigest`.

## 4. Provider currentness semantics

COMPLETE `provider_snapshot` rows are the only authoritative "I looked"
evidence. `reconcileProviderAbsence(claimedBySource)`:

- skips providers whose `sources[]` contain no completed source (never
  reconciles entities discovered through other authorities),
- counts `absence_streak` only when absent from ALL completed sources,
- streak ≥ 1 → `STALE` (inspectable), streak ≥ 3
  (`PROVIDER_REMOVED_ABSENCE_THRESHOLD`) → `REMOVED` (non-routable, history
  preserved — row never deleted),
- `upsertCandidate` on re-observation resets streak and swaps REMOVED→
  REAPPEARED through the normal lifecycle (no silent re-auth).

## 5. Auth semantics

- `providerRoutableGate`: requires `auth_state === "AUTH_OK"`; lifecycle
  DISABLED/UNQUALIFIED/REMOVED blocked explicitly.
- `AUTH_ACCEPTABLE` (qualify): `auth_state === "AUTH_OK"` OR
  `credentialResolvable === "AUTH_OK"`.
- `PROVIDER_AUTH_OK` (eligibility): `auth_state === "AUTH_OK"` only —
  `AUTH_REQUIRED` fails even with a valid receipt (B2 evidence).
- `AUTH_FAILED`/`UNREACHABLE` demote; nothing resurrects auth on restart
  (B4/C3 evidence).

## 6. Provider qualification semantics

`qualify()` mints a `provider_qualification` receipt carrying
`material_fingerprint = providerIdentityDigest(entry)`. Any mutation of
identity material after qualification (endpoint/identity fields) makes the
receipt non-corresponding → `PROVIDER_RECEIPT_CURRENT` FAIL → non-routable
(F1 evidence). Receipt gates only evaluate on entities claiming routable
authority (`PROVIDER_OK_STATES`): DISCOVERED / DISCOVERY_ELIGIBLE /
REMOVED entries report PASS(N/A) instead of double-failing.

## 7. Model qualification semantics

`issueQualificationReceipt` now mints
`material_fingerprint = modelIdentityDigest(entry)` (the model analogue of
§6). `MODEL_RECEIPT_CURRENT` evaluates only when
`lifecycle_state === "QUALIFIED"`: missing receipt → FAIL; fingerprint
mismatch → FAIL; legacy receipts minted pre-Phase-E (no fingerprint field)
pass as legacy-compatible (F2/F3 evidence).

## 8. Receipt validity

A receipt is current iff it exists AND its `material_fingerprint` equals
the entity's current identity digest. Identity drift invalidates the
receipt without deleting it — auditable, reversible only through a new
canonical qualification.

## 9. Provider/model identity decision

Canonical identity stays `(provider_family, model_id)` for model entries
and `provider_id` (normalized) for providers — unchanged. §8 audit:
contradicting `provider_id` claims on the same canonical entry are now
recorded, not folded. No broad identity migration was performed — none
demonstrated a defect requiring one.

## 10. provider_id / provider_family decision

`provider_id` is the authoritative provider link; `provider_family` is the
aliasing identity used only when `provider_id` is absent. Binding minting
(`serve-mission-control.mjs`) and DSH router eligibility now read
`m.provider_id ?? m.provider_family`.

## 11. Binding reconciliation

`projectRoutableModels` surfaces every binding row — including orphan
(missing model), inactive-provider, and REMOVED-model rows — with its full
gate vector; none are routable (G1–G4 evidence).

## 12. Canonical routability definition

`eligible == true` requires every gate in
`providerModelEligibility` PASS: PROVIDER_QUALIFIED, PROVIDER_AUTH_OK,
PROVIDER_PROBE_CURRENT, PROVIDER_HEALTH_OK, PROVIDER_NOT_BLOCKED,
PROVIDER_RECEIPT_CURRENT, MODEL_QUALIFIED, MODEL_NOT_STALE,
MODEL_NOT_REVOKED, MODEL_AVAILABLE, MODEL_RECEIPT_CURRENT (+ executor
gates in the joined projection). AUTHORITY_GATES (Planner + DSH) now
include both receipt gates — violations throw fail-closed; availability
gates remain failover-eligible rejects.

## 13. Planner/DSH runtime proof

- Planner (`assertPlannerCandidateEligible`): role → eligibility gates →
  AUTHORITY throw on receipt-gate violation; demoted provider →
  `FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE` (J1, F1 evidence).
- DSH (`assertDshCandidateEligible` via bound router): executor
  registered/enabled/qualified/healthy → binding → candidate eligibility;
  removed model stops new dispatch (J2/J4); unbound governed dispatch →
  `FAIL_CLOSED_DSH_MODEL_ROUTER_UNBOUND` (J3 — no env-route bypass).
- Live boot (`PAIR_MC_DIR=/tmp/phe-live`, real credentials): §23 chain
  below.

## 14. Secret sanitization evidence

- I1: `upsertCandidate({api_key:"sk-live-secret"})` →
  `FAIL_CLOSED_SECRET_VALUE_IN_PROVIDER_PAYLOAD`.
- I3/I4: `registerSensitiveMaterial("sk-live-token-…")` + probe throws
  `remote 500: Authorization Bearer <secret> rejected` → persisted
  `PROVIDER_PROBE_FAILED` event metadata contains
  `[REDACTED:SECRET_MATERIAL]`, never the raw value; `store.list("provider")`
  and `store.listEvents()` serializations contain no secret.
- Boot registers every declared `credential_reference_name` env value with
  `registerSensitiveMaterial`.

## 15. Restart / idempotency evidence

K1/K2: three consecutive `runProviderDiscovery` runs → unchanged, single
entry; `PairEvidenceStore` reopen → still one entry, REMOVED state and
`absence_streak` preserved across close/reopen (C3).

## 16. Concurrency / CAS evidence

K3: two writers on the same `version` — the loser's `store.put` throws
`FAIL_CLOSED_VERSION_CONFLICT`; no torn state. Role reconcile stays
atomic/idempotent (H4, `store.immediate` transaction).

## 17. Mission Control observability

Eligibility responses name the exact failing gate
(e.g. live boot: `CAPABILITY_TEXT_INFERENCE: FAIL` on the gemini planner
route). Provider projection exposes `credential_status:
configured|unavailable` — never a value.

## 18. Live E2E (§23) — PASS, minimal probes

Scratch `PAIR_MC_DIR=/tmp/phe-live`, `PAIR_DSH_HOME=~/.pair-dsh-home`,
`PAIR_DSH_MODEL_ROUTE=groq:openai/gpt-oss-20b`, real env credentials
(GROQ/GEMINI keys present, values never printed):

```
DISCOVERY: providers {"created":["nvidia","cloudflare","groq","gemini","badq"]}
DISCOVERY: models   {"created":[6 model_entries]}
MODEL_ROLE: reconciled {"created":[4 assignments]}
MODEL_ROUTE: gemini:gemini-3.1-flash-lite model NOT qualified
  {"CAPABILITY_TEXT_INFERENCE":"FAIL"} probe: FAIL   ← real fail-closed evidence
MODEL_ROUTE: badq:openai/gpt-oss-20b QUALIFIED (probe PASS) — planner only
MODEL_ROUTE: groq:openai/gpt-oss-20b QUALIFIED (probe PASS) bound to DEEPSEEK_HARNESS
MODEL_ROUTE: cloudflare:@cf/zai-org/glm-4.7-flash QUALIFIED (probe PASS) bound
/api/providers: gemini/groq/badq/cloudflare QUALIFIED AUTH_OK PROBED +receipt
                nvidia DISCOVERY_ELIGIBLE AUTH_OK UNPROBED no-receipt
                ← enumeration-only state carries no runtime authority
```

Chain proven live: provider discovered → validated → model discovered →
model probed → model qualified → role reconciled → binding qualified →
canonical routability → eligibility proof (gemini route refused by its
exact failing gate; qualified routes bound). Probe calls: one POST per
configured route (4 total) — negligible paid usage.

## 19. Focused tests — `src/__tests__/pair-phase-e-provider-model-authority.test.ts`

**34/34 PASS** — matrix A–K per §21:

- A1–A3: DISCOVERY_ELIGIBLE has no routing authority; enumeration scans it
  without promotion; bootstrap cannot inflate authority.
- B1–B4: CREDENTIAL_MISSING / AUTH_REQUIRED never routable; AUTH_OK+all
  gates → eligible; revoked credential removes the route.
- C1–C4: sole-source disappearance → STALE→REMOVED; second source keeps
  provider current; restart does not resurrect; reappearance follows
  REAPPEARED lifecycle.
- D1–D4: COMPLETE-only STALE→REMOVED; FAILED never removes; REMOVED model
  non-routable; reappearance reuses the entry.
- E1–E4: stable provider/model identity; provider_id conflict →
  contradiction recorded; configured route resolves canonically or fails
  closed.
- F1–F3: stale/mismatched/missing receipts cannot grant routing; valid
  current receipts succeed.
- G1–G4: orphan/inactive/REMOVED rows surface non-routable; valid chain
  routable.
- H1–H4: Planner∩DSH disjoint; unresolved route fails closed; reconcile
  atomic+idempotent.
- I1–I4: raw credential rejected; reference name allowed; external error
  sanitized before persistence and MC output.
- J1–J4: Planner/DSH per-invocation re-proof; no env bypass
  (`FAIL_CLOSED_DSH_MODEL_ROUTER_UNBOUND`); invalidation stops dispatch.
- K1–K3: refresh/restart idempotency; CAS conflict fails closed.

## 20. Full regression (§22)

```
focused Phase E suite:  34/34 PASS
incident suite (§20):   106/106 PASS (pair-live-ops-recovery-closure + R8 paths verified in run)
full suite:             2694 pass / 2 fail / 24 skip  (2720 total)
tsc --noEmit:           clean
pnpm build:             clean
```

Baseline at b08e8a5 recorded 2669 pass / 2 fail / 15 skip (2686 total).
Current run = baseline + 34 new tests, all passing; +9 env-conditional
skips (live-integration files skip without live env). The 2 failures are
the SAME env-only P5 assertions reproduced on BASE (`dsh`/`codex`
executables genuinely exist on this box's PATH, so `probe().available` is
true where the fixture expects not-found) — no functional regression:
identical failures were recorded on the base SHA before any Phase E edit.

## 21. Changed files

- `src/pair/provider-catalog.ts` — DISCOVERY_ELIGIBLE lifecycle +
  PROVIDER_DISCOVERY_SCAN_STATES + PROVIDER_REMOVED_ABSENCE_THRESHOLD +
  sanitizeDiagnostic + sanitized probe detail + reconcileProviderAbsence +
  recordProviderSnapshot
- `src/pair/provider-discovery.ts` — per-source claim sets, COMPLETE/FAILED
  snapshots, reconcile call, sanitized errors, extended return
- `src/pair/provider-validation.ts` — sanitized probe detail;
  AUTH_ACCEPTABLE strict AUTH_OK; providerRoutableGate blocks
  DISABLED/UNQUALIFIED/REMOVED
- `src/pair/model-routable.ts` — gate hardening (PROBE_CURRENT prefix,
  NOT_BLOCKED+REMOVED, PROVIDER_RECEIPT_CURRENT, MODEL_RECEIPT_CURRENT)
- `src/pair/model-catalog.ts` — provider_id contradiction recording;
  model receipt material_fingerprint
- `src/pair/model-discovery.ts` — PROVIDER_DISCOVERY_SCAN_STATES gate;
  makeDefaultHttpGet(timeoutMs); discoveryTimeoutMs in context
- `src/pair/env-config.ts` — MODEL_DISCOVERY_TIMEOUT knob +
  modelDiscoveryTimeoutMs()
- `src/pair/model-role.ts` — AUTHORITY_GATES += receipt gates
- `src/pair/dsh-model-router.ts` — DSH_AUTHORITY_GATES += receipt gates;
  eligibility via provider_id ?? provider_family
- `src/pair/dsh-adapter.ts` — compatEnvRouteFallback dep;
  FAIL_CLOSED_DSH_MODEL_ROUTER_UNBOUND when unbound
- `scripts/serve-mission-control.mjs` — §3 enumeration-only bootstrap +
  §15 registerSensitiveMaterial + §13 planner independence + §9
  provider_id binding + §14 discovery timeout wiring
- tests: `pair-p5.test.ts`, `pair-p6.test.ts`, `pair-phase-b.test.ts`,
  `pair-phase-c-dsh-model-routing.test.ts` — fixtures mirror canonical
  qualification (probe_state, receipts, compatEnvRouteFallback declared)
- new: `src/__tests__/pair-phase-e-provider-model-authority.test.ts` (34)
- new: this report

## 22. Remaining limitations / debt

- The 2 P5 env assertions still fail on machines where real `dsh`/`codex`
  binaries exist (documented since baseline; not Phase E scope).
- `DISCOVERY_ELIGIBLE` is a state on the canonical lifecycle enum — any
  external consumer comparing lifecycle strings verbatim should treat it
  as "enumeration only".
- Model receipts minted before Phase E lack `material_fingerprint`; they
  pass as legacy until the model is re-qualified (fingerprint then binds).
- The gemini planner route fails its capability probe in this environment
  (real evidence of fail-closed behavior; unrelated to Phase E changes —
  the model's upstream endpoint rejected the probe).

STOP. DO NOT MERGE. Awaiting independent audit.

---

# PHASE E — R1 REMEDIATION (audited HEAD: `a46d8a984ebb7e1500f46d7e991a1d7151cc3990`)

Independent audit of the Phase E core found nine blockers (§1–§12). R1 closes
all of them on this same branch; the original Phase E evidence above is
preserved verbatim.

## R1.1 Root causes and closed semantics

- **§1 STALE = NOT CURRENT = NOT ROUTABLE.** `PROVIDER_NOT_BLOCKED` covered
  DISABLED/UNQUALIFIED/REMOVED but left STALE routable inside the threshold
  window. New gate **`PROVIDER_CURRENT`** fails whenever
  `conditions` contains `STALE` or `REMOVED` — the first authoritative
  absence already revokes new-work authority (history stays inspectable).
  The gate is evaluated on the availability channel (failover-eligible),
  so planner/DSH reject with a structured rejection, never silently invoke.
- **§2 Provider reappearance restores OBSERVATION only.** Previously a
  re-observed REMOVED provider kept `QUALIFIED`/`AUTH_OK`/`PROBED` and its
  receipt pointer, instantly regaining routing authority. Now
  `upsertCandidate` — on REMOVED *or* STALE re-observation — records
  `REAPPEARED` and demotes to `DISCOVERY_ELIGIBLE` + `AUTH_REQUIRED` +
  `UNPROBED`. Historical rows (receipt, events) stay inspectable; only the
  normal `validateAccess → probe → qualify` chain mints NEW authority.
- **§3 Model reappearance identical.** `upsertModelClaim` now clears
  STALE/REMOVED → `REAPPEARED` + `lifecycle_state = DISCOVERED` (previously
  STALE was never even cleared, and re-observed REMOVED models kept
  QUALIFIED). Re-qualification re-mints a new/current receipt.
- **§4/§5 Canonical provider↔model linkage.** New gate
  **`MODEL_PROVIDER_MATCH`**: `model.provider_id === provider.provider_id`,
  else FAIL — a qualified P2 cannot pass independent gates into routing a
  model owned by P1. `ensureBinding` throws
  `FAIL_CLOSED_MODEL_PROVIDER_LINK_MISMATCH` at mutation time; injected
  pre-R1 malformed rows project `routable=false` with
  `MODEL_PROVIDER_MATCH=FAIL`; `qualifyBinding` on such rows throws the
  same error. The gate lives inside `providerModelEligibility`, so
  Planner, DSH, and `projectRoutableModels` all share it (§17: zero
  invocations before the throw).
- **§6/§7 Legacy fail-open removed.** `MODEL_RECEIPT_CURRENT` no longer
  passes on `material_fingerprint === undefined`: a QUALIFIED model needs a
  receipt AND a matching fingerprint. Policy **A** applied — legacy rows
  remain historical evidence; fresh probe+qualification mints the bound
  receipt (no blind hash backfill).
- **§8/§9/§10 Source disappearance semantics — explicit.** A source that
  never recorded a snapshot and reports `supports()=false` is
  "never configured" → silently skipped. A source with a prior COMPLETE
  snapshot reporting `supports()=false` is a "previously-active
  authoritative source disappeared" → records an `ABSENT` snapshot and
  contributes an authoritative empty claim set, so providers solely
  dependent on it lose currentness through the normal bounded streak
  (STALE→REMOVED). No indefinite last-known-good grant; FAILED snapshots
  still never remove. Scope invariant: `source_id` is the authority key —
  one source_id = one authority scope per store (documented; a test pins
  the silent-vs-ABSENT distinction).
- **§11 Contradiction = authority violation.** New gate
  **`MODEL_PROVIDER_IDENTITY_CONSISTENT`** FAILs when the canonical entry
  carries an unresolved `provider_id` contradiction. Added to
  `AUTHORITY_GATES`/`DSH_AUTHORITY_GATES` → planner/DSH throw fail-closed.
- **§12 Fingerprint binds provider ownership.** `modelIdentityDigest` now
  includes `provider_id`, so a qualification receipt is bound to the
  provider↔model linkage itself, not only the aliasing family+model
  identity.

## R1.2 New tests (§13–§20) — 11 added, focused suite 45/45

- §13 STALE provider: `PROVIDER_CURRENT` FAIL → planner reject + DSH reject
  + projection non-routable, zero invocations.
- §14 provider QUALIFIED→STALE→REMOVED→re-observe → REAPPEARED/
  DISCOVERY_ELIGIBLE/AUTH_REQUIRED/UNPROBED → non-routable + old receipt
  inspectable → fresh validateAccess/probe/qualify → routable with NEW
  receipt.
- §15 model same: REMOVED→re-observe → REAPPEARED/DISCOVERED → non-routable
  → fresh qualify → routable.
- §16 `ensureBinding`(P2, model-of-P1) throws
  `FAIL_CLOSED_MODEL_PROVIDER_LINK_MISMATCH`; injected QUALIFIED malformed
  binding → `routable=false` + `MODEL_PROVIDER_MATCH` FAIL +
  `qualifyBinding` throws.
- §17 planner + DSH throw `FAIL_CLOSED_*` on linkage-mismatched candidates
  (missing/contradictory `provider_id`) before any invocation.
- §18 injected legacy fingerprint-less receipt → `MODEL_RECEIPT_CURRENT`
  FAIL → re-qualification restores authority with bound fingerprint.
- §12 `modelIdentityDigest` differs when `provider_id` differs.
- §19 unresolved `provider_id` contradiction →
  `MODEL_PROVIDER_IDENTITY_CONSISTENT` FAIL → planner throws.
- §20 previously-active source `supports()=false` → ABSENT snapshot →
  bounded STALE→REMOVED; never-configured source → silent skip.

## R1.3 Regression

- Focused Phase E suite: **45/45 PASS** (34 original + 11 R1).
- Related suites: phase-a 16/16, phase-b 66/66, phase-c-dsh 51/51,
  planner-dataflow incident, llm-planner 16/16, phase-d 37/37,
  live-ops-recovery 20/20 — all PASS.
- Full suite: **2714 pass / 2 fail / 15 skip (2731)** — the 2 fails are the
  same pre-existing env-only P5 assertions documented since baseline
  (`EXECUTABLE_NOT_FOUND` — real `dsh`/`codex` binaries on PATH; reproduce
  on base `b08e8a5` and audited HEAD `a46d8a9`). +11 vs Phase E suite size.
- `npx tsc --noEmit`: clean. `pnpm build`: clean.
- Live E2E re-run with R1 code (scratch `PAIR_MC_DIR`, real credentials):
  boot chain intact — 5 providers discovered, 3 routes QUALIFIED+bound,
  `nvidia` remains unqualified/`DISCOVERY_ELIGIBLE` with no receipt —
  identical canonical chain evidence as the original Phase E run.

## R1.4 Files changed in R1

- `src/pair/model-routable.ts` — `PROVIDER_CURRENT`,
  `MODEL_PROVIDER_MATCH`, `MODEL_PROVIDER_IDENTITY_CONSISTENT` gates;
  legacy fail-open removed from `MODEL_RECEIPT_CURRENT`;
  `ensureBinding`/`qualifyBinding` → `FAIL_CLOSED_MODEL_PROVIDER_LINK_MISMATCH`.
- `src/pair/provider-catalog.ts` — reappearance demotion
  (REAPPEARED→DISCOVERY_ELIGIBLE/AUTH_REQUIRED/UNPROBED);
  `hasCompletedSnapshot`.
- `src/pair/model-catalog.ts` — reappearance demotion
  (REAPPEARED→DISCOVERED); `modelIdentityDigest` += `provider_id`.
- `src/pair/provider-discovery.ts` — §8/§9 source-disappearance semantics
  (silent skip vs authoritative ABSENT claim).
- `src/pair/model-role.ts`, `src/pair/dsh-model-router.ts` —
  AUTHORITY_GATES += linkage/consistency gates.
- `src/__tests__/pair-phase-e-provider-model-authority.test.ts` — +11 R1
  tests (§13–§20); C4 comment updated.
- this report — R1 section appended (original evidence preserved).

STOP. DO NOT MERGE. Awaiting independent audit of R1.
