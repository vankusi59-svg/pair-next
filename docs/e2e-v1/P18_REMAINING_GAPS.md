# P16–P18 Remaining Gaps — V1

## Product/UX gaps (not defects)

1. **No HTTP mint surface for `objective_relation` / `org_agent_duty`** — canonical substrate requires service-level minting (sidecar). For operator UX, a governed owner mint route (same authority checks, same digest/dedup contract) is the natural next surface. Until then, relations/duties are operator-invisible in Mission Control except through projections.
2. **Relation index maintenance is strictly typed** — a dangling `objective_relation_index` row wedges `admissionView` (`FAIL_CLOSED_RELATION_INDEX`). Correct fail-closed behavior, but there is no owner-facing repair/reindex tool; recovery requires operator intervention at storage level.
3. **`WAITING_FOR_CEO` outcome naming** — `POST /ceo-cycle` returning `WAITING_FOR_CEO` after an ACCEPTED decision is technically correct (continuation pending) but reads like an error to operators.
4. **Objective status transitions lack an HTTP route** for non-signoff transitions (CANCEL/PAUSE) — `transitionStatus` is service-only. Same product-gap class as (1).

## Environmental/operational gaps

5. **`PAIR_CEO_MODEL` was required for this subscription** — `gpt-6.1-sol` is not in the operator's ChatGPT catalog; the env seam (`9347193`) is on an unmerged branch. Until merged, a fresh deploy on this account cannot run the CEO cycle.
6. **DSH provider `agnes` qualifies on unauthenticated probe** — `validateAccess`'s HTTP probe treats a reachable non-401 endpoint as AUTH_OK; agnes's gateway accepts unauthenticated `/chat/completions` pings, so it reports QUALIFIED at boot while remaining unusable for real work (no key). Qualification ≠ invocable; consider binding qualification to an authenticated probe receipt.
7. **DSH route resolution requires a live catalog at boot** — `PAIR_DSH_MODEL_ROUTE` must resolve to a canonical model_entry or boot fails closed. "DSH off" = registered-but-unqualified, not absent-route. An explicit "no DSH role" configuration (skip role entirely) would reduce boot friction.
8. **Codex subscription rate limits bound autonomous throughput** — driver passes cost real model invocations (~7–19k tokens each); `max_ceo_calls`/`max_missions` caps work as intended but real-world scale needs cadence planning.

## Verification gaps (evidence-quality, acknowledged)

9. **G3/G4 were observed, not drilled** — executor-failure and reasoner-unavailable evidence comes from capability-gap projection + the prior `SUBSCRIPTION_AUTH_UNVERIFIED` run + unit suites, not a dedicated forced-fault scenario this run.
10. **UI assertions are presence-level** — no screenshot-diff or interaction-level acceptance (e.g., actually clicking owner actions in UI). Pages were verified to render live canonical data, not fabricated states.
11. **No load/concurrency stress** — CONFLICT_LEASE_HELD was observed once live; sustained multi-objective concurrency under driver cadence is untested.
12. **Restart evidence is single-cycle** — one kill+relaunch on the same db; no crash-mid-write fault injection.

## Deferred by scope

- P19+ features; Telegram/chat delivery E2E (read grants minted but no live telegram transport); Devin executor path (UNQUALIFIED without key); multi-business isolation beyond scope-field checks (single business this run — cross-objective isolation proven, cross-business untested live).
