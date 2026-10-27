# P18.6 — Goal-Intent Benchmark

## Dataset

`scripts/dev-verification/fixtures/goal-intent-benchmark.json` —
`pair.goal-intent-benchmark.v1`, **61 scenarios** (regenerate:
`node scripts/dev-verification/gen-goal-intent-benchmark.cjs`).

| Family | n | Coverage |
|---|---|---|
| paraphrase | 10 | equivalent intent EN/VI/mixed |
| negation | 6 | prohibition scope EN/VI |
| preference | 5 | soft preferences / priorities |
| temporal | 6 | relative deadlines EN/VI |
| quantity | 5 | ceilings EN/VI + currencies |
| conditional | 6 | if/then, sequencing, thresholds |
| ambiguity | 4 | materially underspecified goals |
| contradiction | 3 | explicit internal conflicts |
| context | 4 | project-context references |
| injection | 2 | instruction-shaped goal text |
| permission | 2 | authority-shaped requirements |
| exception | 3 | except-clauses |
| entity | 3 | audience/resource richness |
| secondary | 2 | dual outcomes |

## Rubric (recorded in the dataset)

A scenario is CORRECT iff every expectation check passes:
`categories_include ⊆ analyzed categories`; `ambiguity_class` equal
when specified; `has_conflict` matches reconciliation conflicts;
`authority_must_not_be` absent from all item classes; `min_items`.

Denominator = 61 (all clearly-specified deterministic expectations).

## Lanes

1. **Seeded-fixture lane** (deterministic pipeline):
   `src/__tests__/pair-goal-intent-benchmark.test.ts` injects each
   scenario's seeded model response at the provider seam and runs the
   REAL validate → reconcile → classify → render pipeline.
   **Result: 61/61 = 100%** (`docs/p18-6/GOAL_INTENT_BENCHMARK_RESULTS.json`).

   **What this number is and is not:** the fixture injects each
   scenario's *expected* model response — it proves the deterministic
   pipeline (schema validation → reconciliation → ambiguity
   classification → authority boundaries → render bounds) is correct
   and zero-authority-violating. It is **not** a real-model accuracy
   measurement and cannot establish a ≥90% real-model claim. The only
   real-model evidence is lane 2 below, reported separately and
   honestly.

2. **Real-model lane** (qualification-gated — the ONLY real-model
   accuracy evidence; no injected expectations):
   `scripts/dev-verification/goal-intent-real-e2e.mjs` qualifies the
   codex-cli transport via `codexPlannerProbe`, then runs 8 live
   scenarios through the real provider call.
   **Result: REAL_MODEL_PARTIAL 6/8** — probe `AUTH_OK`, 8 provider
   requests, model `gpt-6.1-sol`. R-1/R-2/R-4/R-5/R-6/R-8 PASS with
   materially correct interpretations (prohibition, entity, temporal,
   quantity, conditional, priority, ambiguity/missing-information
   categories — all MODEL_INFERRED). R-3 + R-7 hit provider timeouts
   (300 s bound, honest `UNAVAILABLE` — the designed failure shape,
   never fabricated). Latency variance 8–289 s is codex-cli cold-start
   behavior on this host — provider variance recorded separately from
   deterministic failures (`docs/p18-6/GOAL_INTENT_REAL_E2E.json`).

## P18.5 comparison

P18.5 extracted requirements only via lexeme/rule contract minting —
there was no structured interpretation to score. The P18.6 delta this
benchmark measures: provenance-classed interpretation items
(intent/entities/constraints/preferences/temporal/quantity/conditional
/ambiguity/conflict) survive a deterministic pipeline without
becoming authority — semantic *understanding coverage*, not contract
correctness (contract correctness is covered by goal-contract /
plan-coverage suites, unchanged and still authoritative).
