# P18.5 Independent Integration Audit

- **Auditor**: independent reviewer subagent (not the implementer), re-audited after remediation
- **Scope**: `2174e91..e9271c2` — two commits (`481ca38` F10, `e9271c2` test infra)
- **Initial verdict**: FIX-THEN-SHIP — 8 findings (6 F10 + 2 tmpdir), all verified by repro
- **Post-remediation**: all findings fixed, repro-verified, pinned as regression probes

## Findings & dispositions

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| F1 | HIGH | Currency-prefixed / word-gap ceilings minted nothing (`at most $500`, `maximum of 5`) | Fixed: `of` optional, currency-prefix bound typed as money; probe H56 |
| F2 | HIGH | Decimal amounts magnitude-stripped (`2.5 USD` → `25`) | Fixed: decimals parse as real magnitudes; grouped-only separators still group; H57 |
| F3 | HIGH | Cross-currency evidence: USD amount satisfied a VND bound | Fixed: instruction amounts carry currency tags; mismatched currency never satisfies/violates — no FX fabricated; H58 |
| F4 | HIGH | Single-clause multi-dimension shadowing (budget + files bound, only one evaluated) | Fixed: independent obligation per dimension + only-terms, each emitted once; H59 |
| F5 | HIGH | Object-count evasion via adjective gap (`200 malicious files` bound to `files`) | Fixed: ≤2 modifier words between number and unit noun; plan-wide sum + produced artifacts |
| F6 | HIGH | File-unit zero evidence → vacuous PROVEN | Fixed: file-like units with no bound number and no produced artifact → PRESERVED |
| F9 | MED | `PAIR_TMP_SWEEP_MIN_AGE_MS=0` turned sweep into delete-all in every worker | Fixed: NaN/negative → default; floor 5min; env validated |
| F10 | MED | Lifecycle test S6 ran a zero-age global sweep inside a worker — could delete other workers' dirs | Fixed: S6 asserts scope/prefix/age guards on a synthetic dir; no live sweep of foreign dirs |
| F11 | MED | No live-pid check — age-gated sweep could remove dirs owned by running-but-slow workers | Fixed: `.pair-tmp-owner` pid checked; live pid shields at any age, dead pid = orphan |
| F12 | LOW | Sweep age used mtime only | Fixed: age = max(dir mtime, marker ts) — marker refresh keeps active dirs young |
| F14 | LOW | H55 forged-hint test asserted `pair_coverage` at wrong metadata shape (top-level vs `metadata.pair_coverage`) — probe vacuous | Fixed: nested shape + explicit error-code assertion |
| F15 | LOW | Dead `mkdtempSync` imports in 3 agent test files | Fixed: removed |

## Scope verdicts

- **D1 constraint authority**: no ceiling bypass path remains; ceiling clauses cannot mint floors at any of three mint sites; advisory `pair_coverage` cannot substitute for a violated bound; unverifiable hard bounds fail closed (PRESERVED/INCOMPLETE, never PROVEN).
- **D2 resource safety**: deletion is bounded by (prefix allowlist) ∩ (under `os.tmpdir()`) ∩ (age gate, floored) ∩ (not live-pid-owned) ∩ (not in active registry); idempotent; per-worker registries cannot cross-delete; env input validated.
- **D3 regression/compat**: P18 semantic/replan/preview/confirm suites green; 23-file codemod blast radius verified identical failure counts vs `2174e91` clean baseline (all Windows-platform pre-existing).

## Informational (documented, not blocking)

- `instructionAmounts` money evidence is plan-text provenance — it bounds *declared* per-task spend, not runtime metered spend. Runtime `SpendTracker`/TreasuryPolicy remains the execution-side enforcement; this change does not claim to meter live spend. Correct per the mission boundary (plan-time enforcement; runtime policy untouched).
- Sweep cannot remove dirs with open SQLite handles while the owning test process still runs — by design; age-gated sweep reclaims them after exit.
