# STRUCTURED NETWORK REQUIREMENT — R2 Remediation Report

**Status:** `PAIR_NEXT_STRUCTURED_NETWORK_REQUIREMENT_R2_PENDING_AUDIT`
**PR:** [#51](https://github.com/vankusi59-svg/pair-next/pull/51) — OPEN, NOT MERGED (operator merges after independent audit)
**Audited base:** R1 HEAD `93ebb82` (`STRUCTURED NETWORK REQUIREMENT R1`, branch `devin/1791196681-netreq-struct`)
**R2 scope:** close the 2 authority blockers found by the R1 audit, plus directly-related invariants — no parallel architecture, no merge, no PRV2-B.

---

## 1. Root cause of the two blockers

### BLOCKER 1 — planner declaration could bootstrap its own capability
Under R1, `repairNetworkCapabilityBinding` elevated a task to `NETWORK_ACCESS` whenever the
emitted `network_requirement` was *internally consistent* (`EXTERNAL_*` + locator +
freshness REQUIRED). The planner's own prose was the only authority input: a forged or
mistyped `source_kind: EXTERNAL_*` minted a governed capability that the operator goal
never authorized. The semantic requirement (A) was allowed to imply the operator-authorized
capability scope (B) without canonical operator-side authorization (C).

### BLOCKER 2 — missing/malformed field silently fell back to legacy vocabulary detectors
Under R1, `req === null` (planner omitted the field, or sanitize dropped it) made the
authority resolver return `NOT_REQUIRED`, and the plan-level legacy detectors
(`goalRequiresCurrentExternalData` + friends) then decided network need from instruction
vocabulary — the exact per-language keyword surface R1 was built to remove. A malformed or
conflicting field was even *dropped by sanitize*, laundering a contract violation into a
legacy-detector plan.

---

## 2. What R2 changed

### 2.1 Unified authority verdict — `resolveTaskNetworkAuthority` (network-requirement.ts)
ONE function now produces the authority verdict consumed by **both** the repair seam and
the canonicalizer gate:

```
malformed | conflict            → INVALID(REQUIREMENT_MALFORMED | REQUIREMENT_CONFLICT)
req === null                    → fresh ? INVALID(REQUIREMENT_MISSING) : LEGACY
internal contradiction          → INVALID(LOCAL_WITH_EXTERNAL_LOCATOR | LOCATOR_WITHOUT_SOURCE)
!requiresAccess (LOCAL/UNKNOWN) → NOT_REQUIRED
!operatorAuthorized             → INVALID(UNAUTHORIZED_SOURCE)
else                            → REQUIRED{ authorized: true }
```

and the canonicalizer additionally throws `UNAUTHORIZED_CAPABILITY` when a NOT_REQUIRED
task still declares `NETWORK_ACCESS`.

### 2.2 Operator-side canonical authorization (closes BLOCKER 1)
Authorization is derived from **what the operator goal itself names**, never from planner
prose. Two extraction channels feed `extractGoalIdentities(goal)`:

1. `extractGoalHosts` — `scheme://` URLs parsed via `new URL`, plus bare dotted-host
   matches (`(?<![\w/.-])[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?![\w/.-])`); `www.` stripped.
   Generic syntax only — **no TLD vocabulary anywhere** (the `EXTERNAL_LOCATOR_RE`
   hard-coded TLD list is gone, replaced by shape classification per mandate).
2. Proper-noun-shaped tokens — a token qualifies iff it contains a digit, an uppercase
   letter past index 0 (camelCase brands like `OpenAI`), or ≥2 ALL-CAPS letters
   (`GPT`, `EA`, `MQL5`, `MT5`, `BTC`). Plain lowercase nouns and sentence-initial
   capitals never qualify.

`goalAuthorizesHost(host, identities)` matches iff `host === g`,
`host.endsWith("." + g)`, `g.endsWith("." + host)`, or `g` is a label of `host`
(`host.split(".").includes(g)`) — so a goal saying *"research MQL5 EAs"* yields identity
`mql5`, which authorizes locator `mql5.com` (label membership) without enumerating TLDs.

`networkRequirementOperatorAuthorized(req, identities)` is true only when the declared
`source_locator` host is authorized by that set. A `REQUIRED`/`EXTERNAL_*` requirement with
an unauthorized or missing source fails `INVALID(UNAUTHORIZED_SOURCE)` — planner
declaration can *propose* semantics, PAIR-owned validation *decides* authorization.

### 2.3 Provenance-gated legacy compat (closes BLOCKER 2)
Call-site provenance, never inferred from missing data:
`makeServeCanonicalizer(rawTasks, goal, ctx?: { provenance?: "fresh" | "persisted" })`.
`"fresh"` is the default everywhere; `"persisted"` is passed ONLY at the serve-planner
resume path reading `metadata.llm_plan` (a genuinely persisted, pre-R2 plan). Persisted
plans keep the legacy detector path; fresh emissions missing the field are typed
`REQUIREMENT_MISSING` rejections — re-ask/failover, never silent vocabulary fallback.
`PAIR_PLAN_CONTRACT_VERSION` stays 2 (no contract bump needed for a call-site flag).

### 2.4 Sanitize marks instead of dropping
A conflict or malformed `network_requirement` no longer drops the task: sanitize writes a
digest-covered `metadata.network_requirement_error` marker (`CONFLICT` | `MALFORMED`),
deletes the field, and the canonical gate throws the typed INVALID. A forged marker can
only ever produce INVALID — it grants nothing (fail-closed). Marker is in the
plan-feasibility digest whitelist.

### 2.5 Emission vs post-sanitize shape
The model emits top-level `network_requirement`; sanitize normalizes to
`metadata.network_requirement` (top-level authoritative; metadata honored only when
top-level absent; non-identical both-present → CONFLICT marker). Repair + gate read the
metadata home; test fixtures dual-write for the direct-repair-call seam.

### 2.6 Ordering & exemptions
The network gate runs BEFORE `assertPlanCoverage` (requirement errors reject before
coverage UNDECLARED). Injected bookkeeping tasks (`canonicalBookkeepingTask`) stay exempt
from the fresh requirement contract. Reserved/special task handling unchanged.

---

## 3. Precedence

`structured verdict (fresh)` > `typed INVALID` > `LEGACY (persisted provenance only)` —
legacy vocabulary detectors (`goalRequiresCurrentExternalData`, `taskRequiresNetworkAccess`,
`instructionIsDataGathering`, `instructionSatisfiesGoalSubject`) run ONLY under the LEGACY
verdict (persisted provenance) and the plan-level legacy check when `!anyDerivedRequired`.

---

## 4. Validation evidence

### 4.1 Focused suites (all green)
| Suite | Result |
|---|---|
| pair-network-requirement (R2 unit matrix incl. identities/locator generality) | 15/15 |
| pair-network-binding-repair (rewritten R2 adversarial: forged, UNAUTHORIZED_SOURCE/CAPABILITY, MISSING, MALFORMED, both transports) | 10/10 |
| pair-covmap-coverage-map | 19/19 |
| pair-prv2b-goal-coverage | 52/52 |
| pair-prv2a-planner-modernization (incl. `canonLegacy` persisted-provenance matrix) | 59/59 |
| pair-cpl1-codex-planner | 49/49 |
| 9-suite regression batch (llm-planner, preask, pgrammar2, dataflow-incident, f3-feasibility, route-capability, acr1, cni1, inference-router) | 354/354 |
| pair-f3-r1-remediation (fixture migration to fresh contract) | 20/20 |

### 4.2 Production-path forged test (J3 correction satisfied)
Adversarial T1–T3/T10 in `pair-network-binding-repair.test.ts` traverse the REAL
`sanitizePlan → repairNetworkCapabilityBinding → makeServeCanonicalizer` production path
on both transports (llmPlan + codexPlannerPlan lanes): forged `EXTERNAL_*` on a goal that
does not name the host → `FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID
{"task":..,"reason":"UNAUTHORIZED_SOURCE"}`; forged + declared `NETWORK_ACCESS` →
`UNAUTHORIZED_CAPABILITY`. No capability is minted.

### 4.3 Malformed / missing / conflict behavior
- Fresh task omitting `network_requirement` → `INVALID(REQUIREMENT_MISSING)` (typed, re-ask eligible — not legacy).
- Malformed field → `INVALID(REQUIREMENT_MALFORMED)` via the `MALFORMED` marker.
- Top-level vs metadata non-identical both-present → `INVALID(REQUIREMENT_CONFLICT)`.
- Valid `UNKNOWN` accepted, zero elevation (NOT_REQUIRED → no NETWORK_ACCESS, and declaring the cap → `UNAUTHORIZED_CAPABILITY`).
- Persisted (pre-R2) fieldless plan → LEGACY verdict → legacy detectors honored (compat preserved).

### 4.4 Multilingual / locator generality proof
No language regex exists in the authorization path — goal identities are extracted by
character-shape only (digits / camelCase / ALL-CAPS), hosts by syntax only (no TLD list).
Coverage: Vietnamese + English + code-mixed fixtures across the suites; a locator on a
non-listed TLD (`api.btc.example`) is authorized purely via goal identity `BTC`.

### 4.5 Digest/replay
`network_requirement` + `network_requirement_error` are digest-covered via the
plan-feasibility whitelist; restart/replay suites (f3-r1-remediation, cpl1) green —
persisted plans replay identically.

### 4.6 Full suite / typecheck / build
- `npx vitest run`: **3649 pass / 3 fail** — the 3 are the unchanged baseline
  (2× P5 env-only + F4 `R5.1-crash`). Zero new failures vs the 3650/3 pre-R2 baseline
  (delta of 1 pass count is suite reshaping, not a dropped test).
- `npx tsc --noEmit`: clean. `rm -rf dist && pnpm build`: clean.

---

## 5. Live proofs (scratch stack :8790, `PAIR_MC_DIR=/home/ubuntu/pair-mc-netreq`, dist = R2 HEAD)

### Positive — external-fetch goal through the full production path
`POST /api/missions` goal *"Fetch the current gold price from MQL5.com, write the result
to outbox/gold.txt, then send that file to Telegram."* →
`MSN_01M461G649ZXHKDACSJEHPBJJM` CREATED, plan minted by sol (gpt-6.1-sol) first attempt:

- T2 emitted **fresh valid structured requirement**
  `{source_kind:"EXTERNAL_SITE", access_intent:"FETCH", freshness:"REQUIRED",
  source_locator:"https://www.mql5.com"}` → operator-side authorization PROVEN
  (goal names `MQL5.com`) → `REQUIRED{authorized}` → canonical
  `required_capabilities: ["FILE_OPERATIONS","NETWORK_ACCESS"]` — capability derived
  from the structured field, not instruction vocabulary.
- T3 emitted `{source_kind:"LOCAL", access_intent:"READ", freshness:"NOT_REQUIRED",
  source_locator:"outbox/gold.txt"}` → zero NETWORK_ACCESS.
- T1 bookkeeping exempt.
- Network gate green → preview `MPP_01M461G6474TXSHB49A9PM6B0W` → plan digest
  `cc1bba05…` → T2 dispatched on CODEX (`RTE_CODEX_CLI`, RUNNING).

### Negative — forged EXTERNAL on a pure-math goal (controlled seam, dist build)
`Tính căn bậc hai của 144…` + forged requirement `{EXTERNAL_SITE, FETCH, REQUIRED,
locator:"https://mql5.com"}`:

- canonical gate → `FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID {"reason":"UNAUTHORIZED_SOURCE"}` — zero elevation.
- repair seam → caps unchanged `["FILE_OPERATIONS"]`, zero warnings — no bind.
- control (same requirement on a goal that DOES name the host) → authorization passes
  (reaches the downstream capability check, no UNAUTHORIZED).
- repair seam on the authorized goal + cap omitted → binds `NETWORK_ACCESS`,
  warning `REPAIRED_NETWORK_CAPABILITY:T2`.

### Missing field — fresh contract
Fresh task without `network_requirement` →
`FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID {"reason":"REQUIREMENT_MISSING"}` —
typed rejection, never legacy fallback.

### Normal local goal
Valid `LOCAL` requirement on a local goal → accepted, `NETWORK_ACCESS` absent.

### Exact MQL5 goal — gated by out-of-scope Bug A
The verbatim 10-EA research goal still EXHAUSTs, now dying on
`FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION` (PRV2-B `prohibitionTerms`: the goal's own
prohibition clause mints banned tokens incl. `truy`,`cập`). **No attempt died on any
network code** — the structured emission itself was valid; the blocker is orthogonal and
explicitly out of R2 scope (needs the separate structured-constraint/prohibition mandate).

---

## 6. Files changed (vs `93ebb82`)

| File | Change |
|---|---|
| `src/pair/network-requirement.ts` | `resolveTaskNetworkAuthority` unified verdict; `extractGoalIdentities` proper-noun channel; `goalAuthorizesHost` label match; `networkRequirementOperatorAuthorized`; `networkRequirementInternalContradiction`; `networkRequirementFieldState`; TLD-free `LOCATOR_RE`/`HOST_SHAPE_RE`; `NETWORK_REQUIREMENT_ERROR_KEY` |
| `src/pair/llm-planner.ts` | repair rewired to the unified verdict with `extractGoalIdentities`; sanitize marks `network_requirement_error` instead of dropping; prompt AUTHORIZATION bullet |
| `src/pair/serve-planner.ts` | `ctx.provenance` fresh/persisted; net gate consumes the shared verdict (INVALID→typed throw, UNAUTHORIZED_CAPABILITY, LEGACY→detectors) |
| `src/pair/plan-feasibility.ts` | digest whitelist + `network_requirement_error` |
| `src/__tests__/pair-network-requirement.test.ts` | 15-test R2 matrix |
| `src/__tests__/pair-network-binding-repair.test.ts` | rewritten 10-test production-path adversarial suite |
| `src/__tests__/pair-prv2a-planner-modernization.test.ts` | `canonLegacy` persisted provenance + fresh-contract fixtures |
| `src/__tests__/pair-prv2b-goal-coverage.test.ts` | NETREQ_LOCAL/EXT fixtures |
| `src/__tests__/pair-cpl1-codex-planner.test.ts` | schema emission fixtures |
| `src/__tests__/pair-covmap-coverage-map.test.ts` | fresh-contract fixtures |
| `src/__tests__/pair-f3-r1-remediation.test.ts` | replan-emission fixtures |
| `PAIR_NEXT_STRUCTURED_NETWORK_REQUIREMENT_R2_REPORT.md` | this report |
| `CURRENT_STATE.md` | R2 entry |

---

## 7. Remaining risk (disclosed, bounded)

- Bare filename-like dotted tokens in a goal (`math.txt`) count as goal-hosts → a bounded
  false-authorization surface for a locator ending in that exact name.
- Hosts inside *negated* goal clauses currently authorize like positive mentions
  (partially covered downstream by the PRV2-B prohibition gate).
- `LOCAL` + bare-dotted locator degrades to `NOT_REQUIRED` (cannot elevate) — recorded,
  conservative.
- ALL-CAPS entity tokens (`EA`, `BTC`) in a goal become identities → a host whose label
  matches (`ea.x`, `btc.x`) is authorized — bounded over-grant, reported.
- Scratch-stack provider catalog needed `settings.yaml` restore (absence-streak STALE/REMOVED)
  — environment note only, unrelated to the change.

## 8. Explicitly out of scope

**PRV2-B prohibitionTerms (Bug A)** — the goal's prohibition clause mints banned tokens
that kill every MQL5-class plan before execution. Per mandate: *"DO NOT FIX IT IN R2…
requires a separate structured-constraint/prohibition mandate after PR #51 is closed."*

Also unchanged per mandate: NETWORK execution gate semantics, executor capability sets,
model role rules, failover ordering, re-ask budget, Telegram delivery, artifact/FILE
authority, P-COVMAP semantics, F3/F4/F5, P15+ roadmap. No multilingual keywords added.

`PAIR_NEXT_STRUCTURED_NETWORK_REQUIREMENT_R2_PENDING_AUDIT`
