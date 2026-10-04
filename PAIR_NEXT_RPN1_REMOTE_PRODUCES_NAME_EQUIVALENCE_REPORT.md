# RPN-1 — Remote Produces Canonical Name Equivalence Closure

**Classification:** `PAIR_NEXT_RPN1_REMOTE_PRODUCES_NAME_EQUIVALENCE_PENDING_AUDIT`
**Base SHA:** `04e4e8b` (main, post-PR#43 merge — P-GRAMMAR R1+R2 present)
**Branch:** `devin/1791125933-rpn1-remote-produces-equivalence`
**Scope:** ONE seam — the F5 remote `declared_produces` terminal completeness gate in `src/pair/artifact-validation.ts`.

## Live incident reproduction (prod `pair.db`, 2026-10-04)

Mission `MSN_01M43N2JF0PVW834YH37GXYDMJ` — parallel goal (DEVIN remote GitHub-EA survey + CODEX local marketplace research + merge + telegram).

- `GTSK_01M43N2Q5YT6A90P2TGJEYYFWJ` (DEVIN, `REMOTE_CLOUD_TASK_EXECUTION`): `expected_output_contract.declared_produces = ["outbox/github_ea.md"]`, governance `DISPATCH_AUTHORIZED`.
- Devin execution COMPLETED; canonical upload ingested: `ART_04FF2940EEBF648C34D74D7986E05B04` — `logical_name: "github_ea.md"`, `ingested_via: REMOTE_UPLOAD`, `state: ACCEPTED`, 9522 bytes, sha256-pinned, producer DEVIN, bound to that execution.
- Terminal gate `XVLD_01M43N6FKDV1TG5WAJG1CB2WFQ`: `FAIL`, `remote_produces_missing: ["outbox/github_ea.md"]`, `artifact_count: 0`, `referenced_artifact_ids: ["ART_04FF2940…"]` → `DEPENDENCY_FAILURE` (`REMOTE_PRODUCER_ARTIFACT_MISSING`) → REPLAN → ABORT → mission FAILED.

The remote worker did correct, verified work; the gate rejected it purely on a spelling difference that the canonical DSN-1 authority already treats as equivalent.

## Root cause — second, weaker name authority

The completeness loop compared logical names by literal equality:

```ts
const identities = acceptedRows.filter(
  (a) => String(a.logical_name) === name,
).length;
if (identities !== 1) remoteProducesMissing.push(name);
```

`github_ea.md` (uploaded) ≠ `outbox/github_ea.md` (declared) even though `artifactNamesEquivalent()` — the ONE canonical equivalence (DSN-1) — encodes `X ≡ outbox/<basename(X)>` as a pairwise-direct staging alias. The consume seam already uses it; the produce gate did not.

## Semantic change (minimal, fail-closed preserved)

In the same loop, per declared name:

```ts
const exact = acceptedRows.filter((a) => String(a.logical_name) === name);
const candidates =
  exact.length > 0
    ? exact
    : acceptedRows.filter((a) => artifactNamesEquivalent(name, a.logical_name));
if (candidates.length !== 1) remoteProducesMissing.push(name);
```

- **Exact spelling wins first.** The equivalence band applies only when no exact-name artifact exists — so two DISTINCT declared spellings each satisfied by their own exact artifact (`chart.png` + `outbox/chart.png` both declared and both uploaded) never collapse into ambiguity.
- **Equivalence is pairwise-direct only** — `X ≡ outbox/<basename(X)>`; `reports/internal/x ≢ reports/customer/x` and `dirA/x ≢ dirB/x` remain non-equivalent (no basename collapse, no transitive inference).
- **Name match still never authorizes.** Candidates are drawn only from `service.artifacts.forExecution(executionId)` intersected with the independently CAS-verified `acceptedIds` — producer identity, execution/mission/task binding, ACCEPTED state, sha256 and retained-byte verification are unchanged requirements. An equivalent name on a foreign execution's artifact cannot satisfy the claim.
- Exactly-one-identity rule retained: 0 or >1 candidates → `FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:<declared name>`.

DSN-1 itself untouched — the gate now imports and calls `artifactNamesEquivalent` from `artifact-authority.ts` (one authority).

## Test evidence (RPN-1 matrix, `pair-f5-remote-producer-closure.test.ts`)

| Case | Declared | Uploaded (this execution) | Expected | Result |
|---|---|---|---|---|
| A exact | `github_ea.md` | `github_ea.md` | PASS | PASS |
| B outbox alias (live incident) | `outbox/github_ea.md` | `github_ea.md` | PASS | PASS |
| C reverse spelling | `github_ea.md` | `outbox/github_ea.md` | PASS | PASS |
| D wrong dirs | `reports/internal/report.md` | `reports/customer/report.md` | FAIL | FAIL `REMOTE_PRODUCES_INCOMPLETE` |
| E same basename diff dirs | `dirA/x.md` | `dirB/x.md` | FAIL | FAIL |
| F consumed upstream artifact | `outbox/github_ea.md` | (nothing; upstream exec produced `github_ea.md`) | FAIL | FAIL |
| G provenance mismatch | `outbox/github_ea.md` | (foreign exec's `github_ea.md`) | FAIL | FAIL |
| H live incident shape | `outbox/github_ea.md` | `github_ea.md` ACCEPTED | PASS, `failures: []`, no `remote_produces_missing` evidence | PASS |
| I both spellings uploaded | `outbox/github_ea.md` | `github_ea.md` + `outbox/github_ea.md` | PASS (exact wins; extra = surplus produce) | PASS |
| J two declared equivalent spellings | `chart.png` + `outbox/chart.png` | both exact | PASS (no collapse) | PASS |

Focused: **F5 suite 67/67** (58 prior + 9 RPN-1). The DSN-1 D8 fixture (producer declaring both spellings) initially regressed under naive equivalence counting — resolved by the exact-first rule; DSN-1 11/11 green again, and that discovery is now pinned by test J.

## Regression matrix

- DSN-1 consume-name normalization: **11/11**
- F1 artifact authority: 20/20 · F1-R1 25/25 · F1-R2 95/95
- F2 artifact handoff: 53/53 · F2-R1 43/43 · F2-R2 35/35 · F2-R3 18/18 · F2-R4 8/8
- F4 delivery provenance: **61/61**
- P-GRAMMAR / planner dataflow incident: **125/125**
- PRV2-A 59/59 · PRV2-B 51/51
- Recovery: live-ops 20/20 · phase-D 37/37
- Combined focused+regression files: **14 files, 650/650** (+ F5 67/67, DSN-1 11/11)
- **Full suite: 3525 pass / 2 fail** — the two known P5 environment-only failures (stock `DshExecutorAdapter`/`CodexCliExecutorAdapter` probes report `available=true` because the executables exist in this environment); identical to current `main` baseline.
- `tsc --noEmit` clean · `rm -rf dist && pnpm build` clean · `pnpm audit`: 9 findings (1 low, 8 moderate, 0 high/critical) — unchanged lockfile, same as `main` baseline.

## Files changed

- `src/pair/artifact-validation.ts` — import `artifactNamesEquivalent`; declared-name matching loop now exact-first + canonical equivalence fallback.
- `src/__tests__/pair-f5-remote-producer-closure.test.ts` — `artifactNamesEquivalent` import + RPN-1 describe (9 tests A–J).
- `CURRENT_STATE.md` — RPN-1 entry.

## Preserved (verified by existing suites above)

`remote_produces_contract` mint binding, anchor self-validation, declared_produces immutability/digest, count bounds, ACCEPTED-state requirement, producer execution+executor identity, mission/task binding, sha256 + retained-byte verification, F1/F2/F4/DSN-1 authorities, planner failover, delivery provenance.

## Residuals (out of scope, recorded per mandate)

- **Planner Remote Artifact Edge Hardening** — planner candidates repeatedly emit remote-dependent tasks without naming the remote-produced artifact in the consumer instruction (`DROP_REMOTE_DEPENDENT`, observed 3/4 attempts across two planner runs). F2 behaves correctly; left for a separate follow-up.
- **Planner Attempt Typed Error Observability** — `planner_attempt` rows retain only `CANONICAL_VALIDATION_FAILED`; the original typed IntegrityError code is lost.
