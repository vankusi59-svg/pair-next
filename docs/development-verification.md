# Development Verification Harness (V1)

Deterministic repo-local verification for PAIR Next changes. It is
**development tooling only** — it has no production authority and never
touches Planner/Gate/Executor behavior.

## Normal patch workflow

1. Write/update `.pair-verification/patch-claim.json` describing what the
   patch claims to fix/add and which tests prove it.
2. Implement the change.
3. Run `npm run verify:change -- --base <BASE_SHA>`.
4. Fix until it exits 0 (`READY_FOR_INDEPENDENT_AUDIT`).
5. For HIGH-risk changes the full suite runs automatically; `--full`
   forces it for any risk level.
6. Push the PR and attach `.pair-verification/report.md`.
7. Independent audit → merge only after audit PASS.

If `--base` is omitted the harness uses `merge-base` with
`origin/staging/pr59-safe`; any unresolvable base is a typed harness
failure (`VERIFY_BASE_RESOLUTION`), never a silent guess.

## What it checks

- **Patch claim** (`.pair-verification/patch-claim.json`): every
  `required_tests` selector (`file` or `file#vitest -t pattern`) must
  exist and pass. A green tsc/build/full suite can never override a
  failed claim.
- **Invariants**: a permanent registry (`scripts/dev-verification/
  lib.mjs: INVARIANTS`) of ~11 architecture truths mapped to existing
  tests; selected by affected surfaces or declared in the claim.
- **Module packs**: declarative surface→test-file map; changed files
  classify into PLANNER, DELIVERY, CONVERSATION, MISSION_DRAFT,
  MISSION_CONTROL, GATE_ROUTER, ARTIFACT, REMOTE_EXECUTION,
  RECOVERY_REPLAY, BUSINESS_OBJECTIVE, TELEGRAM_INGRESS, UI, DEV_INFRA.
  Unmapped production files select a conservative broad set.
- **tsc + build** gates.

## Risk

HIGH (authority-sensitive: planner canonicalization, delivery
intent/provenance, gate/router, artifact, secrets, recovery/replay,
mission binding, approval, unmapped production), MEDIUM (ordinary
production behavior), LOW (UI/docs/tests/dev-infra only). A patch claim
can only RAISE risk, never downgrade.

## Reports

`.pair-verification/report.md` + `report.json` — regenerated each run,
git-ignored, safe bounded summaries only (no env values, secrets, raw
stderr, or model output). Documented baseline failures are reported as
`KNOWN_BASELINE`, never silently dropped.

## Promoting a bug fix into permanent coverage

bug reproduction → patch-specific test in a focused file → patch fixed →
audit PASS → promote the valuable test into an invariant or module pack
entry in `scripts/dev-verification/lib.mjs`.
