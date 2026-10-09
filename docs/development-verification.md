# Development Verification Harness (V1)

Deterministic repo-local verification for PAIR Next changes. It is
**development tooling only** — it has no production authority and never
touches Planner/Gate/Executor behavior.

Agent policy: running this harness is the mandatory completion contract
for agents working in this repository — see `AGENTS.md` at the repo
root.

## Normal patch workflow

1. Write/update `.pair-verification/patch-claim.json` describing what the
   patch claims to fix/add and which tests prove it. **A patch claim is
   mandatory on any non-empty diff** — without it the harness does not
   know what the patch claims, so `VERIFY_PATCH_CLAIM_REQUIRED` fails
   closed. A docs-only change still uses a minimal claim.
2. Implement the change.
3. Self-audit the `BASE..HEAD` diff across the categories in
   `AGENTS.md` (Self-Audit & Auto-Repair Contract) and record evidence
   in `.pair-verification/self-audit.json` — **mandatory on any
   non-empty diff** (`VERIFY_AUDIT_REQUIRED`). Like the claim, the file
   must itself be inside the current diff (`VERIFY_AUDIT_STALE`); every
   audit category must be either reviewed or explicitly skipped with a
   reason, and unresolved `P0`/`P1` findings or a `BLOCKED` verdict make
   the run `NOT_READY`.
4. Run `npm run verify:change -- --base <BASE_SHA>`.
5. Fix until it exits 0 (`READY_FOR_INDEPENDENT_AUDIT`).
6. For HIGH-risk changes the full suite runs automatically; `--full`
   forces it for any risk level.
7. Push the PR and attach `.pair-verification/report.md`.
8. Independent audit → merge only after audit PASS.

A zero-change diff is a typed `VERIFY_EMPTY_DIFF` failure — the harness
never certifies a patch that does not exist.

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
  Unmapped production files (including unknown `scripts/*` — real runtime
  seams like `serve-mission-control.mjs` and `telegram-bridge.mjs` live
  there and are mapped HIGH) select a conservative broad set + HIGH.

Every selector (`file` or `file#pattern`) proves **fresh, non-vacuous**
evidence: a unique per-invocation result file is deleted before the run
and must be recreated by it; PASS requires ≥1 executed assertion, zero
unaccounted failures, and any non-zero exit explained only by registered
known-baseline failures. Stale JSON, zero-match patterns, malformed
JSON, crashes, and unaccounted exits are all FAIL — never PASS.
- **Self-audit evidence** (`.pair-verification/self-audit.json`):
  structural + consistency checks — category coverage (all 7 accounted
  for), finding severity/provenance/reproduction, fixes bound to real
  finding ids, `repair_rounds ≤ 3`, and a verdict gate: `PASS` is
  rejected while `P0`/`P1` findings are unresolved and `BLOCKED` is
  always `NOT_READY`. Regression test paths named in `fixes` must
  exist. The file is self-attestation — structure/freshness only, never
  independent proof.
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
