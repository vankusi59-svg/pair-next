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

# PHASE E — R2 REMEDIATION (audited R1 HEAD: `2f2e3a534d2a98f3fb22c3ddcd248f13bdf71288`)

Final evidence-authority closure. R1 semantics preserved verbatim.

## R2.1 Root causes and closed semantics

**§1–§3 Historical probe receipts could requalify a reappeared model.**
`qualifyModel()` scanned `listProbeReceipts()` = ALL history, so a
QUALIFIED→STALE→REMOVED→REAPPEARED model could requalify on pre-removal
evidence. Closure: `model_entry.probe_receipt_ids` is now the CURRENT
observation epoch — on REAPPEARED the model resets to
DISCOVERED + `probe_state=UNPROBED` + `last_probe_at=null` +
`current_qualification_receipt_id=null` + `probe_receipt_ids=[]`;
`recordProbeReceipt` appends only into the current window;
`qualifyModel` reads `currentProbeReceipts()` (the window) plus a new
`CURRENT_PROBE_EVIDENCE` gate; minted `evidence_refs` reference only
current probes. Historical `probe_receipt` entities stay persisted and
inspectable — never deleted.

**§4 Direct `issueQualificationReceipt()` could mint QUALIFIED from
arbitrary strings.** Chose option B (harden the seam itself): every
capability in scope must be covered by a PASS `probe_receipt` referenced
in the entry's CURRENT window → else
`FAIL_CLOSED_MODEL_QUALIFICATION_EVIDENCE_MISSING`; every `evidence_ref`
must point into that same window → else
`FAIL_CLOSED_MODEL_QUALIFICATION_EVIDENCE_FOREIGN`. All fixtures updated
to the canonical `recordProbeReceipt` → `qualifyModel` chain (the same
path production runs).

**§5 Provider `probed:true` caller bypass.** `opts.probed === true` was
accepted as probe evidence. Removed from the API —
`PROTOCOL_PROBED = PASS` only when `entry.probe_state === "PROBED"`
(durable canonical state). Fixtures seed PROBED via
`validateAccess(probe)` / `recordProbeObservation` like production.

**§6 Provider reappearance kept a stale current receipt pointer.**
REAPPEARED reset now also clears `current_qualification_receipt_id`
(historical `provider_qualification` rows preserved).

**§7–§10 Configured route `P:M` did not prove provider ownership.**
`resolveConfiguredModelRoleRoute` now throws
`FAIL_CLOSED_MODEL_ROLE_ROUTE_PROVIDER_MISMATCH` when the resolved
entry's canonical `provider_id !== P` — before role assignment, planner
candidate creation, DSH pool construction, or any invocation. Same seam
serves planner and DSH (defense in depth with `MODEL_PROVIDER_MATCH`
and exact `model_binding` linkage).

**§11 `providerRoutableGate` diverged from `PROVIDER_CURRENT`.**
Now blocks STALE too; documented as the provider-only subset of
`providerModelEligibility` — the two cannot disagree on currentness.

## R2.2 New tests (§12–§19) — 6 added, focused suite 51/51

- §12+§13 one scenario: QUALIFIED→STALE→REMOVED→REAPPEARED model →
  `qualifyModel` `qualified=false` (`CURRENT_PROBE_EVIDENCE` +
  `CAPABILITY_TEXT_INFERENCE` FAIL), old probe row inspectable, no new
  receipt → fresh `recordProbeReceipt` → `qualified=true`,
  `evidence_refs=[fresh]` only, routable again.
- §14 direct `issueQualificationReceipt` on DISCOVERED/UNPROBED with
  `evidence_refs:["fresh"]` → `..._EVIDENCE_MISSING`; refs pointing at
  another model's receipt → `..._EVIDENCE_FOREIGN`; no QUALIFIED minted.
- §15+§16 provider REMOVED→REAPPEARED
  (DISCOVERY_ELIGIBLE/AUTH_REQUIRED/UNPROBED) → `qualify()` →
  `PROTOCOL_PROBED` FAIL (AUTH would pass — probe is the blocker), no
  receipt, pointer stays null → real `validateAccess(probe)` → PROBED →
  `qualify` → NEW current receipt; old row inspectable; routable.
- §17 planner route `p2:m` on entry with `provider_id=p1` →
  `FAIL_CLOSED_MODEL_ROLE_ROUTE_PROVIDER_MISMATCH`, zero `model_role`
  mutation.
- §18 same malformed entry via DSH route → same fail-closed before pool.
- §19 first authoritative absence → STALE: `PROVIDER_CURRENT` FAIL and
  `providerRoutableGate.pass=false` — gates agree.

## R2.3 Regression

- Focused Phase E suite: **51/51 PASS** (34 original + 11 R1 + 6 R2).
- Related suites: p6 36/36, p7 36/36, p8 49/49, phase-b 123/123,
  phase-c-dsh 51/51, runtime-hardening 11/11 — all PASS.
- Full suite: **2720 pass / 2 fail / 15 skip (2737)** — the 2 fails are
  the same pre-existing env-only P5 assertions documented since baseline
  (`EXECUTABLE_NOT_FOUND` — real `dsh`/`codex` binaries on PATH;
  reproduce on base `b08e8a5` and audited HEADs). +6 vs R1 count.
- `npx tsc --noEmit`: clean. `pnpm build`: clean.
- Live E2E re-run with R2 code (scratch `PAIR_MC_DIR`, real
  credentials): boot chain intact — 5 providers discovered
  (`nvidia,cloudflare,groq,gemini,badq`), 6 models discovered, 3 routes
  QUALIFIED+bound, DSH pool built. Persisted state confirms the new
  semantics live: `nvidia`/`badq` sit at
  `DISCOVERY_ELIGIBLE/AUTH_OK/UNPROBED` with `receipt=null` (no probe →
  no qualification possible), while qualified models carry
  `probe_receipt_ids` windows pointing at this boot's fresh `PRB_*`
  receipts — exactly the current-epoch authority R2 requires.

## R2.4 Files changed in R2

- `src/pair/model-catalog.ts` — reappearance resets the evidence epoch
  (`probe_state/last_probe_at/current_qualification_receipt_id/
  probe_receipt_ids`); `currentProbeReceipts()`;
  `issueQualificationReceipt` fail-closed evidence validation.
- `src/pair/model-probing.ts` — `qualifyModel` reads current epoch only;
  `CURRENT_PROBE_EVIDENCE` gate.
- `src/pair/provider-catalog.ts` — reappearance clears
  `current_qualification_receipt_id`.
- `src/pair/provider-validation.ts` — `opts.probed` removed;
  `providerRoutableGate` blocks STALE.
- `src/pair/model-role.ts` —
  `FAIL_CLOSED_MODEL_ROLE_ROUTE_PROVIDER_MISMATCH` at configured-route
  resolution.
- `src/__tests__/pair-phase-e-provider-model-authority.test.ts` — +6 R2
  tests; `mkModel`/`qualifyProvider` fixtures now canonical.
- `src/__tests__/pair-phase-b.test.ts`, `pair-phase-c-dsh-model-routing.test.ts`,
  `pair-p6.test.ts` — legitimate fixture updates only (canonical
  probe→qualify chain; no semantics changed).
- this report — R2 section appended; R1 evidence preserved verbatim.

STOP. DO NOT MERGE. Awaiting independent audit of R2.

---

# R3 — QUALIFICATION AUTHORITY + CURRENT PROBE CLOSURE (audited HEAD `ec0a695`)

Second independent audit of R2: **PASS on R2**, but Phase E FINAL = BLOCKED.
The surviving-bug class: a model QUALIFIED receipt stayed valid after a
NEWER canonical probe failed — the receipt binds model identity, not
probe state, so nothing in R2 revoked invocation on fresh failure
evidence. Same class on the provider side: the qualification commit
seam trusted caller-supplied gate results instead of durable state.

## R3.1 Semantics

- **`MODEL_PROBE_CURRENT`** (new gate in `providerModelEligibility`,
  availability-classified — NOT in `AUTHORITY_GATES`/`DSH_AUTHORITY_GATES`):
  PASS ⇔ `model.probe_state === "PROBED"` exactly. Invariant:
  **CURRENT FAILED MODEL PROBE = NO NEW MODEL INVOCATION** —
  `UNPROBED`, `PROBE_*`, or any other state all FAIL. Planner reject and
  DSH reject happen BEFORE invocation/dispatch; the qualification
  receipt and probe history remain inspectable; a fresh PASS probe can
  restore authority (availability semantics).
- **`PROVIDER_PROBE_CURRENT`**: corrected to exact-`PROBED`. The
  previous `!probe_state.startsWith("PROBE_")` let `UNPROBED` pass — a
  never-probed provider read as current probe evidence.
- **`qualifyModel` `CURRENT_PROBE_EVIDENCE`**: PASS ⇔
  `entry.probe_state === "PROBED"`. The LATEST probe state governs — an
  older PASS receipt in the same current window no longer overrides a
  newer failure (`[PASS, FAIL]` epoch → `qualified: false` even though
  `CAPABILITY_*` coverage exists).
- **Provider `issueQualificationReceipt` (commit seam)**: now validates
  durable canonical state itself before minting —
  `auth_state === "AUTH_OK"`, `probe_state === "PROBED"`, no
  `STALE`/`REMOVED` condition, and every recorded gate value
  `=== "PASS"`. Violations throw
  `FAIL_CLOSED_PROVIDER_QUALIFICATION_STATE` /
  `FAIL_CLOSED_PROVIDER_QUALIFICATION_GATES`; no receipt row, no
  lifecycle/condition mutation. `DISABLED`/`UNQUALIFIED` are
  deliberately NOT rejected: DISABLED is operator authority preserved
  through canonical requalification (61F — routability is separately
  blocked by `PROVIDER_NOT_BLOCKED`), and UNQUALIFIED is transient
  residue this same transition canonically clears (60A–E) — rejecting
  either would deadlock legitimate flows.
- **Model `issueQualificationReceipt`**: likewise refuses
  `probe_state !== "PROBED"` (`FAIL_CLOSED_MODEL_QUALIFICATION_STATE`)
  so a direct seam call cannot mint over a newer failure even when
  older-PASS coverage exists.
- **`currentProbeReceipts` ownership**: a receipt in the window must
  satisfy `receipt.model_entry_id === modelEntryId` AND (when both carry
  `provider_id`) `receipt.provider_id === model.provider_id`. A corrupt
  window referencing another model's probe id yields ZERO evidence.
- **`evidence_refs` derivation**: the minted model qualification records
  the ACTUAL covering current PASS receipts (derived internally from
  `currentProbeReceipts` + capability coverage), never caller strings.
  `evidence_refs: []` at call time still mints a fully traceable
  receipt; caller-supplied refs are still validated against the current
  window (`..._FOREIGN`).

## R3.2 Tests (mandate §8–§16, +6 focused tests → 57/57)

- **r3p** (§8+§9): `AUTH_OK`/`UNPROBED`/`DISCOVERY_ELIGIBLE` provider +
  forged all-PASS gates → `FAIL_CLOSED_PROVIDER_QUALIFICATION_STATE`;
  no receipt, `PROVIDER_PROBE_CURRENT` FAIL, `providerRoutableGate`
  false. Forged `WARN` gate → `..._GATES`. Then real `validateAccess`
  probe → `PROBED` → `qualify()` → receipt minted, gate PASS.
- **r12** (§12): qualified+routable planner + DSH models; new FAIL
  probes → `probe_state="PROBE_FAIL"`, `MODEL_PROBE_CURRENT` FAIL,
  `eligible=false`, planner `{reject:true}`, DSH `{reject:true}`,
  projection non-routable — all before any invocation; old PASS receipt
  stays inspectable (`listProbeReceipts`), qualification receipt kept.
- **r13m** (§13): fresh PASS → `PROBED` → `qualifyModel` → new receipt;
  `evidence_refs` = exactly the covering current PASS ids (FAIL receipt
  excluded); eligible again.
- **r14** (§14): epoch `[PASS, FAIL]` → `qualifyModel` refuses
  (`CURRENT_PROBE_EVIDENCE` FAIL while `CAPABILITY_TEXT_INFERENCE` PASS
  — proof the refusal is current-state, not missing evidence); raw seam
  agrees via `FAIL_CLOSED_MODEL_QUALIFICATION_STATE`; no receipt.
- **r15** (§15): model A window injected with model B's probe id →
  `currentProbeReceipts(A)` = `[]`; `qualifyModel(A)` fails coverage;
  seam throws `..._MISSING`; no receipt minted.
- **r16** (§16): `issueQualificationReceipt` with `evidence_refs: []` on
  a covered model → mints with `evidence_refs` = actual covering PASS
  probe ids (non-empty, traceable).

## R3.3 Regression

- Focused Phase E suite: **57/57** (34 original + 11 R1 + 6 R2 + 6 R3).
- Related suites re-run: phase-b 123/123, phase-c-dsh 51/51, p6 36/36,
  runtime-hardening 11/11 — PASS (legitimate fixture updates: mirror
  canonical post-qualification `AUTH_OK`/`PROBED` state, `gates` values
  `"PASS"`; no test semantics weakened).
- Full suite: **2726 pass / 2 fail / 15 skip (2743)** — the 2 fails are
  the same pre-existing env-only P5 assertions
  (`EXECUTABLE_NOT_FOUND` — real `dsh`/`codex` binaries on PATH;
  identical on base `b08e8a5` and both audited HEADs). +6 vs R2 count.
- `npx tsc --noEmit`: clean. `pnpm build`: clean.
- R1–R8 incident invariants: all preserved suites pass inside the full
  run (planner dataflow 106/106, recovery-approval 37/37, ops telegram
  delivery, live-ops recovery closure — no Telegram/dataflow semantics
  touched).

## R3.4 Files changed in R3

- `src/pair/model-routable.ts` — `PROVIDER_PROBE_CURRENT` exact-PROBED;
  new `MODEL_PROBE_CURRENT` gate (availability classification).
- `src/pair/model-probing.ts` — `CURRENT_PROBE_EVIDENCE` reads
  `probe_state`; `evidence_refs` filtered to PASS receipts.
- `src/pair/model-catalog.ts` — `currentProbeReceipts` ownership
  verification; `issueQualificationReceipt` probe-state gate +
  internally-derived covering `evidence_refs`.
- `src/pair/provider-catalog.ts` — `issueQualificationReceipt` durable
  state + all-PASS gates validation (two dedicated fail-closed errors).
- `src/__tests__/pair-phase-e-provider-model-authority.test.ts` — +6 R3
  tests; `mkModel` unchanged (already canonical).
- `src/__tests__/pair-phase-b.test.ts`,
  `pair-phase-c-dsh-model-routing.test.ts`, `pair-p6.test.ts` —
  legitimate fixture updates only: qualified lifecycles mint under
  canonical `AUTH_OK`/`PROBED`, caller-degraded states applied
  post-receipt (mirroring credential revocation ordering).
- this report — R3 section appended; R1+R2 evidence preserved verbatim.

STOP. DO NOT MERGE. Awaiting independent audit of R3.

---

# R4 — CAPABILITY-SCOPED CURRENT EVIDENCE + PROVIDER GATE COMPLETENESS

Audited HEAD: `957cb9960a858f2dc10eefac73c4102118a3c064` (R3).
Three remaining evidence-authority gaps closed on the same PR, same
branch, no new PR, no merge:

- **§1–§4 Provider commit trust gap** — `issueQualificationReceipt`
  trusted caller-supplied gate maps: `gates: {}` minted a receipt on a
  canonical AUTH_OK/PROBED provider.
- **§5–§10 Probe currentness was global, not capability-scoped** —
  `probe_state==="PROBED"` and "any PASS in window" meant a PASS for
  vision could revive text_inference after its latest FAIL.
- **§11–§13 Probe receipts were not strictly provider-owned** —
  `provider_id: null` (or a foreign provider id) rows counted as
  current evidence.

## R4.1 Semantics

1. **Canonical required provider gate set** (§2/§3) — exported once as
   `PROVIDER_QUALIFICATION_REQUIRED_GATES` from `provider-catalog.ts`
   (`PROVIDER_EXISTS`, `AUTH_ACCEPTABLE`, `PROTOCOL_PROBED`,
   `HEALTH_ACCEPTABLE`, `POLICY_PERMITS`). The commit seam now
   validates: every required gate PRESENT (missing →
   `FAIL_CLOSED_PROVIDER_QUALIFICATION_GATES` with `missing_gates`
   detail), every required gate `==="PASS"` (non-PASS → same error,
   `failing_gates`). Ordering preserved: durable-state check
   (`..._STATE`) → presence → values. Extra diagnostic gates tolerated,
   never substitutive. `qualify()` emits exactly the canonical set.
2. **Latest-per-capability currentness** (§5–§9) — new seam
   `probeCurrentForCapability(model_entry_id, capability)`: the LATEST
   receipt (canonical `probe_receipt_ids` append order — monotonic,
   wall-clock-free) applicable to that capability must be a PASS that
   evidences it (`capability_evidence[cap]==="PASS"`/`true`, or a typed
   probe `probe_type===cap` with no contradicting `passed:false`).
   Applicability = `probe_type===cap` ∪ `requested_capability===cap` ∪
   `capability_evidence` declares the cap. A PASS for vision cannot
   revive text_inference. Global `MODEL_PROBE_CURRENT` retained as an
   additional availability gate; the authority gate is
   `MODEL_CAPABILITY_PROBE_CURRENT` on the receipt's
   `capability_scope` (N/A-PASS for non-QUALIFIED models —
   `MODEL_QUALIFIED`/`MODEL_RECEIPT_CURRENT` govern that axis).
   `issueQualificationReceipt` now requires current covering evidence
   PER CAPABILITY (`FAIL_CLOSED_MODEL_QUALIFICATION_EVIDENCE_MISSING`);
   the R3 global `probe_state` pre-check was removed (superseded —
   a [text PASS, vision FAIL] model must still qualify for text).
   `CURRENT_PROBE_EVIDENCE` and `CAPABILITY_<cap>` in `qualifyModel`
   both read the per-capability seam.
3. **Commit authority is the model seam** (§10) —
   `issueQualificationReceipt` is the ONLY path from durable evidence
   to `QUALIFIED`; `evidence_refs` = the latest covering receipt per
   required capability (superseded PASS receipts excluded). Caller
   `evidence_refs` still cannot widen beyond the window (FOREIGN
   rejection preserved).
4. **Strict provider ownership** (§11–§13) — `recordProbeReceipt`
   throws `FAIL_CLOSED_PROBE_PROVIDER_MISMATCH` when both
   `entry.provider_id` and `receipt.provider_id` are non-null and
   differ (fail closed at recording, including `probeModel`, which
   already stamps `provider_id` from the canonical entry).
   `currentProbeReceipts` additionally requires
   `receipt.provider_id === entry.provider_id` when the model declares
   one — `null`-provider and foreign-provider rows stay inspectable in
   `listProbeReceipts` but are never current authority
   (projection-time filtering retained for legacy/corrupt rows).
5. **§19 preserved** — `DISCOVERY_ELIGIBLE`/`DISABLED`/`UNQUALIFIED`
   semantics untouched: technical qualification ≠ operator enablement;
   DISABLED stays non-routable even when technically re-qualified;
   UNQUALIFIED residue is still cleared by canonical requalification
   (explicitly asserted in r4p).

## R4.2 Tests (focused Phase E: 62/62)

- **r4p** (§4): healthy AUTH_OK/PROBED provider + `gates:{}` →
  `..._GATES`, no receipt, no promotion; each of the 5 required gates
  removed individually → `..._GATES`; forged `POLICY_PERMITS:"FAIL"` →
  `..._GATES`. §19 probe: DISABLED provider mints technically but keeps
  `DISABLED` and `providerRoutableGate.pass===false`.
- **r4x** (§14): text PASS → qualify → planner-eligible; text FAIL →
  `MODEL_CAPABILITY_PROBE_CURRENT` FAIL + planner `{reject:true}`;
  vision PASS → global `probe_state` flips PROBED but scoped gate
  stays FAIL, `qualifyModel(["text_inference"])` refuses with
  `CAPABILITY_TEXT_INFERENCE:"FAIL"`, planner still rejects.
- **r4m** (§15): text+tools PASS → `["text_inference","tools"]`
  qualified + routable; tools FAIL → scoped gate FAIL →
  re-qualification refused; fresh tools PASS → both gates PASS →
  qualified + routable again.
- **r4s** (§16): PASS#1 + PASS#2 → receipt `evidence_refs ===
  ["PRB_s_2"]` (superseded #1 excluded); FAIL#3 → all three inspectable
  via `listProbeReceipts`, qualification + scoped gate FAIL.
- **r4o** (§17/§18): `provider_id: null` receipt records into the
  window but `currentProbeReceipts` = `[]` → qualification refused
  (never-qualified model: scoped gate N/A-PASS, `MODEL_QUALIFIED`
  holds the failure); `provider_id:"other-provider"` →
  `FAIL_CLOSED_PROBE_PROVIDER_MISMATCH` at recording; the same row
  injected past the boundary is excluded at projection → still no
  qualification; fresh provider-bound PASS → qualifies.
- **Fixture updates (legitimate, semantics unchanged)**: every
  `recordProbeReceipt` call now declares `provider_id` (strict
  ownership); provider seam callers pass the full canonical gate set
  (`Object.fromEntries(PROVIDER_QUALIFICATION_REQUIRED_GATES...)`);
  R3 r13 assertion narrowed to latest-covering refs; R3 r14
  `CAPABILITY_TEXT_INFERENCE` now FAIL (latest FAIL supersedes older
  PASS) and seam error is `..._MISSING`; r3p forged gate maps use the
  canonical set so the durable-STATE check fires as intended.

## R4.3 Regression

- Focused Phase E suite: **62/62** (34 + 11 R1 + 6 R2 + 6 R3 + 5 R4).
- R1–R8 incident invariants re-run: planner-dataflow 106/106,
  recovery-approval 37/37, ops-telegram-delivery 3/3,
  live-ops-recovery-closure 20/20, runtime-hardening 11/11 — 177/177.
- Sibling seam consumers: phase-b 123/123, phase-c-dsh 51/51,
  p6 36/36.
- Full suite: **2731 pass / 2 fail / 15 skip (2748)** — the 2 fails are
  the same pre-existing env-only P5 assertions
  (`EXECUTABLE_NOT_FOUND` — real `dsh`/`codex` on PATH; identical on
  base `b08e8a5` and all audited HEADs). +5 vs R3 count.
- `npx tsc --noEmit`: clean. `pnpm build`: clean.
- Live E2E: unchanged from R2 (R4 touches evidence seams only, not the
  boot path).

## R4.4 Files changed in R4

- `src/pair/provider-catalog.ts` — exported
  `PROVIDER_QUALIFICATION_REQUIRED_GATES`; commit seam requires
  presence + all-PASS.
- `src/pair/model-catalog.ts` — `recordProbeReceipt` provider mismatch
  throw; `currentProbeReceipts` strict provider ownership; new
  `receiptAppliesToCapability` / `latestProbeReceiptForCapability` /
  `probeCurrentForCapability`; `issueQualificationReceipt`
  per-capability coverage + latest-covering `evidence_refs`.
- `src/pair/model-probing.ts` — `CURRENT_PROBE_EVIDENCE` +
  `CAPABILITY_<cap>` read the per-capability seam.
- `src/pair/model-routable.ts` — `MODEL_CAPABILITY_PROBE_CURRENT` gate.
- `src/__tests__/pair-phase-e-provider-model-authority.test.ts` —
  +5 R4 tests, fixture provider_ids, R3 assertion updates.
- `src/__tests__/pair-phase-b.test.ts`,
  `pair-phase-c-dsh-model-routing.test.ts`, `pair-p6.test.ts` —
  legitimate fixture updates only (provider_id on receipts, canonical
  gate set).
- this report — R4 section appended; all prior evidence preserved.

STOP. DO NOT MERGE. Awaiting independent audit of R4.

# R5 remediation — independent-audit MAJOR + CRITICAL closures

Audited R4 HEAD: `149d6a348d20f5023e388c7b43ec4c3530932960`.

## R5.1 Root cause and fix

Two remaining fail-open seams:

1. **Empty capability_scope passed qualification.** `Array.every` on
   `[]` is vacuously true, so `qualifyModel(capability_scope=[])` minted
   a QUALIFIED model + receipt with zero covering evidence — a real
   authority bypass (the scope list was treated as trusted input at
   qualify time, commit time, and runtime). Fix: canonical contract
   `normalizeCapabilityScope` (model-catalog, exported once) — scope
   must be a non-empty array of non-blank identifiers; values are
   trimmed and deduplicated (first-seen order); anything else throws
   `FAIL_CLOSED_MODEL_QUALIFICATION_SCOPE`. Enforced INDEPENDENTLY at
   both `qualifyModel()` (diagnostic path) and
   `ModelEvidenceCatalog.issueQualificationReceipt()` (commit seam) —
   neither trusts the other. Runtime: new gate
   `MODEL_QUALIFICATION_SCOPE_VALID` in the shared eligibility
   projection — a QUALIFIED model whose current receipt carries a
   legacy empty/malformed scope → FAIL → planner + DSH reject;
   historical receipt remains inspectable; recovery requires a fresh
   probe + canonical requalification (tested).
2. **Provider qualification receipt still trusted caller-supplied gate
   VALUES.** `issueQualificationReceipt` accepted a caller `gates` map:
   `POLICY_PERMITS`/`HEALTH_ACCEPTABLE` were not independently
   derivable inside the seam, so `PASS` was forgeable — authority
   bypass. Fix: one canonical computation
   `ProviderCatalog.computeQualificationDecision(providerId, {env,
   policyDenyList, policyVersion})` returns `{qualified, gates,
   policy_version}` for all five required gates —
   PROVIDER_EXISTS (trivial), AUTH_ACCEPTABLE (durable AUTH_OK or
   `providerCredentialResolvable` env check), PROTOCOL_PROBED (durable
   `probe_state==="PROBED"`), HEALTH_ACCEPTABLE (durable health not
   UNAVAILABLE/DOWN), POLICY_PERMITS (not in caller policyDenyList).
   The commit seam no longer takes `gates` at all — forged values are
   structurally impossible; it calls the canonical function and throws
   `FAIL_CLOSED_PROVIDER_QUALIFICATION_GATES` (with `failing_gates`)
   when the decision is unqualified. `ProviderValidator.qualify()` now
   delegates to the same function — single implementation, no
   duplicated gate logic. POLICY_PERMITS stays caller-influenced only
   through the caller's own policy input (denylist), which is correct
   authority semantics, not a forge.
   Runtime: `PROVIDER_RECEIPT_CURRENT` now requires the canonical
   required gate set to be present and `==="PASS"` inside the CURRENT
   receipt — an injected fingerprint-valid receipt with `gates:{}` or
   `POLICY_PERMITS:"FAIL"` set as current → FAIL → non-routable; a
   complete valid receipt → PASS (control).

## R5.2 R5 tests (new)

- **r5s** (§13 A/B/C + §15): `qualifyModel([])` throws
  `FAIL_CLOSED_MODEL_QUALIFICATION_SCOPE` — no receipt, no QUALIFIED;
  direct seam `issueQualificationReceipt([])` / `[""]` / `["   "]` /
  `["\t\n"]` fail closed identically; control
  `[" text_inference ","text_inference"]` → normalized
  `["text_inference"]`, qualifies, `evidence_refs` point at the current
  covering probe.
- **r5l** (§14): injected QUALIFIED model + fingerprint-valid receipt
  with `capability_scope:[]` set as current →
  `MODEL_QUALIFICATION_SCOPE_VALID` FAIL → planner reject + DSH reject,
  projection non-routable; canonical probe + `qualifyModel` clears it.
- **r5d** (§8): AUTH_OK+PROBED+READY but `policyDenyList:[pid]` →
  `qualify()` returns unqualified with `POLICY_PERMITS:"FAIL"`, no
  receipt, non-routable; direct seam call identical; **smuggling
  `{gates:{POLICY_PERMITS:"PASS"}}` into the seam no longer compiles/
  applies** — the signature has no `gates` parameter.
- **r5h** (§9): `health_state:"DOWN"` → `HEALTH_ACCEPTABLE:"FAIL"` →
  no qualification; health restored → canonical qualify succeeds.
- **r5r1/r5r2/r5r3** (§11/§12): `injectReceipt` plants a current
  fingerprint-valid `provider_qualification` with `gates:{}` →
  `PROVIDER_RECEIPT_CURRENT` FAIL, non-routable; same with
  `POLICY_PERMITS:"FAIL"` → FAIL; all-PASS canonical gates → PASS +
  eligible (control).
- **Fixture updates (legitimate)**: all provider seam callers updated
  to the new signature (`{policy_version, actor, env?, policyDenyList?}`);
  phase-b/phase-c `mkProvider` now mints under canonical healthy state
  and applies requested `auth_state`/`health_state` degradation AFTER
  the receipt (post-qualification degradation ordering, same as the
  credential-revocation pattern).

## R5.3 Regression

- Focused Phase E suite: **69/69** (34 + 11 R1 + 6 R2 + 6 R3 + 5 R4 + 7 R5).
- Incident invariants (full run): planner-dataflow 106/106,
  recovery-approval 37/37, ops-telegram-delivery 3/3,
  live-ops-recovery-closure 20/20, runtime-hardening 11/11 — 177/177.
- Sibling seam consumers: phase-b 123/123, phase-c-dsh 51/51,
  p6 36/36.
- Full suite: **2738 pass / 2 fail / 15 skip (2755)** — the 2 fails are
  the same pre-existing env-only P5 assertions
  (`EXECUTABLE_NOT_FOUND` — real `dsh`/`codex` on PATH; identical on
  base `b08e8a5` and every audited HEAD). +7 vs R4 count.
- `npx tsc --noEmit`: clean. `pnpm build`: clean.
- Live E2E: unchanged from R2 (R5 touches qualification/evidence seams
  only, not the boot path).

## R5.4 Files changed in R5

- `src/pair/provider-catalog.ts` — `providerCredentialResolvable`
  export; new `computeQualificationDecision` (single canonical gate
  authority); `issueQualificationReceipt` signature no longer accepts
  `gates` — consumes the canonical decision.
- `src/pair/provider-validation.ts` — `qualify()` delegates to
  `computeQualificationDecision`; `credentialResolvable` delegates to
  `providerCredentialResolvable`.
- `src/pair/model-catalog.ts` — `normalizeCapabilityScope` +
  `isValidCapabilityScope`; commit seam validates + normalizes scope.
- `src/pair/model-probing.ts` — `qualifyModel` normalizes scope
  independently before the gate loop.
- `src/pair/model-routable.ts` — `PROVIDER_RECEIPT_CURRENT` requires
  the canonical required gate set inside the current receipt; new
  `MODEL_QUALIFICATION_SCOPE_VALID` gate.
- `src/__tests__/pair-phase-e-provider-model-authority.test.ts` —
  +7 R5 tests; seam call-sites updated; r3p/r4p rewritten for the
  gates-free signature.
- `src/__tests__/pair-phase-b.test.ts`,
  `pair-phase-c-dsh-model-routing.test.ts`, `pair-p6.test.ts` —
  fixture signature updates + post-receipt degradation ordering.
- this report — R5 section appended; all prior evidence preserved.

STOP. DO NOT MERGE. Awaiting independent audit of R5.

# R6 remediation — independent-audit CAPABILITY-SCOPED RUNTIME AUTHORITY closure

Audited R5 HEAD: `0e7dcff99bb2921fcb1cb1d9f1dafaaccf2be57d`.

## R6.1 Root cause and fix

One narrow runtime semantic conflict: `providerModelEligibility` still
carried `MODEL_PROBE_CURRENT = model.probe_state === "PROBED"`.
`model.probe_state` is a GLOBAL summary — every `recordProbeReceipt`
overwrites it regardless of capability. An unrelated capability failure
therefore revoked a healthy qualified capability (vision FAIL →
probe_state=PROBE_FAIL → whole model ineligible even though latest
text_inference was PASS), contradicting R4's capability-scoped
authority model.

Fix (minimal, per §3): `MODEL_PROBE_CURRENT` removed from model runtime
authority. `model.probe_state` remains as operator observability /
diagnostic summary only. Authoritative runtime model gates are now:
`MODEL_QUALIFIED`, `MODEL_RECEIPT_CURRENT`,
`MODEL_QUALIFICATION_SCOPE_VALID`, `MODEL_CAPABILITY_PROBE_CURRENT`
(+ provider/currentness/revocation gates). No parallel capability
state was introduced. Unqualified-model behavior unchanged —
`MODEL_QUALIFIED` governs; global `PROBED` alone never grants
authority (§4/§8).

Both directions of the invariant hold: failure of capability B does
NOT revoke capability A while A's latest canonical probe is PASS;
PASS of B does NOT revive failed A.

## R6.2 R6 tests (new)

- **r6a** (§5): text qualified + routable on planner AND DSH models;
  vision FAIL on both → `probe_state=PROBE_FAIL` (summary) but
  `MODEL_CAPABILITY_PROBE_CURRENT` PASS, `eligible=true`,
  `assertPlannerCandidateEligible` + `assertDshCandidateEligible` pass.
- **r6b** (§6): text FAIL → blocked; vision PASS →
  `probe_state=PROBED` summary but text stays non-routable
  (scoped gate FAIL, planner rejects).
- **r6c** (§7): scope [text,tools] + vision FAIL → still routable;
  tools FAIL → not routable; fresh tools PASS → routable. Only
  in-scope failures revoke.
- **r6d** (§8): unqualified model + vision PASS → `probe_state=PROBED`
  summary, `MODEL_QUALIFIED` FAIL, non-routable — summary state never
  mints authority.
- **Fixture updates (legitimate)**: two R3 assertions switched from
  the removed `MODEL_PROBE_CURRENT` to `MODEL_CAPABILITY_PROBE_CURRENT`
  (same outcome — the failed capability was the qualified one).

## R6.3 Regression

- Focused Phase E suite: **73/73** (34 + 11 R1 + 6 R2 + 6 R3 + 5 R4 + 7 R5 + 4 R6).
- Incident invariants (full run): planner-dataflow 106/106,
  recovery-approval 37/37, ops-telegram-delivery 3/3,
  live-ops-recovery-closure 20/20, runtime-hardening 11/11 — 177/177.
- Sibling seam consumers: phase-b 123/123, phase-c-dsh 51/51,
  p6 36/36.
- Full suite: **2742 pass / 2 fail / 15 skip (2759)** — the 2 fails are
  the same pre-existing env-only P5 assertions
  (`EXECUTABLE_NOT_FOUND` — real `dsh`/`codex` on PATH; identical on
  base `b08e8a5` and every audited HEAD). +4 vs R5 count.
- `npx tsc --noEmit`: clean. `pnpm build`: clean.
- Live E2E: unchanged from R2 (R6 touches the eligibility projection
  only, not the boot path).

## R6.4 Files changed in R6

- `src/pair/model-routable.ts` — `MODEL_PROBE_CURRENT` removed from
  `providerModelEligibility`; `probe_state` documented as
  summary/observability only.
- `src/__tests__/pair-phase-e-provider-model-authority.test.ts` —
  +4 R6 tests; two R3 assertions retargeted to the scoped gate.
- this report — R6 section appended; all prior evidence preserved.

STOP. DO NOT MERGE. Awaiting independent audit of R6.
