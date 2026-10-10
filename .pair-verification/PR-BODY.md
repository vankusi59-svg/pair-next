## Summary

Closes the KPI-UNVERIFIED gap proven on the live P15.10-C operation test: missions completed and artifacts accepted, yet `kpi.current` never moved because no governed path turned accepted artifacts into KPI progress. This adds that path — one delegated verifier contract, reusing the existing P15.1 ledger/write seam — never an owner impersonation and never a second writer.

Four-tier outcome, kept explicit everywhere: **Artifact Accepted → Deliverable Verified → KPI Progress Verified → KPI Target Met**; acceptance alone still means KPI `UNVERIFIED`, and all-targets-met still yields `TARGET_MET_CANDIDATE` with `owner_action_required`, never auto-`ACHIEVED`.

**Authority contract (new, opt-in, default OFF):**
- Grant entity `objective_kpi_auto_authorization` (KVA_) — owner-only create; pins `business_id + objective_id + kpi_id + verify rule + objective_terms_version + expires_at`; `ENABLED|DISABLED|REVOKED`; exactly one ENABLED grant per (objective, kpi); past grants stay auditable.
- Rule vocabulary: `DELIVERABLE_BUNDLE` only — `{required_count? or required_keys?, progress_value}`; unknown fields and empty rules reject.
- Receipt entity `kpi_verification_receipt` (KVR_) — immutable; digest binds auth + objective + business + kpi + terms_version + rule_digest + verified_units + progress_value.
- New verifier kind `kpi-verifier:<auth_id>`; single canonical writer actor `PAIR_KPI_VERIFIER`.

**Write path (`ObjectiveKpiVerificationService.verifyGrant`, one `store.immediate`):** grant re-validated effective (owner, scope, kpi, terms, expiry, objective non-terminal) → verified units re-derived from canonical lineage (workstream child folded DONE via WAL `delegated_child_work_item_id` + `wal.business_id` → `boundMissionForWorkItem` → `assertCanonicalMissionCompletion` → ≥1 ACCEPTED artifact whose `governed_task.mission_id` matches) → rule satisfaction → digest-dedup replay (`REPLAYED`, no double-count) → KVR + event → existing `objectives.recordProgress` with `evidence_key = kva:<auth>:<receipt_id>`. `objective-authority.assertOwnerVerifier` extended: `kpi-verifier:*` requires `actor === PAIR_KPI_VERIFIER` then `assertKpiVerifierAuthority` (grant effective + receipt exists + produced_by + digest recompute + optional kpi_id/value claim binding). P15.5 `assertCanonicalObjectiveKpiProgress` applies the same re-validation on read — revoked/expired/drifted grants invalidate recorded progress retroactively. Operating loop calls `kpiVerification.advance(objectiveId)` once per pass before §6; optional dep, absent = off. Route: `POST /api/vnext/objectives/:id/kpi-verification` (`status|grant|revoke|disable`, `x-operator-id`).

**Tests:** `pair-p15-10d.test.ts` 22/22 — A1 acceptance reproduces the P15.10-C gap end-to-end (pre UNVERIFIED → 1-of-2 UNVERIFIED → all verified → MET → TARGET_MET_CANDIDATE + owner gate) plus B1–B15 adversarial vectors (forged/unaccepted/tampered artifact, cross-objective/cross-business evidence, executor self-report, replay inflation, same-key conflict, racing verifiers, revoke/terms-drift/terminal, foreign-KPI claim, out-of-scope KPI type) and C1–C6 grant-contract edges. Regressions: P15.1 (66), P15.5 (58), P15.6 (69), P15.10a/b/c all rounds (103+) — all green; tsc + build clean.

**Verification:** `npm run verify:change -- --base 88470ee` → `READY_FOR_INDEPENDENT_AUDIT`. Design map: `.pair-verification/P15-10D-MAP.md`.

No merge (independent audit first), no deploy; production driver remains OFF. Out of scope: planner/router, cost service, mission creation contract, scheduler lifecycle, UI, memory/brain.
