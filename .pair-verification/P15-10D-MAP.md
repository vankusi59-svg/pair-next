# P15.10-D implementation map — BASE 88470ee (staging/pr59-safe post-#87)

## Canonical authority analysis (verified by reading)

- `objective-authority.ts` `recordProgress` + `attachEvidence` → `assertOwnerVerifier`
  (line ~1174): ONLY `verifier === objective.owner_authority_id` && actor === owner. All
  other verifier kinds fail closed `FAIL_CLOSED_OBJECTIVE_UNVERIFIED`.
- `objective-adaptive-review.ts` `assertCanonicalObjectiveKpiProgress` (line ~196):
  PROGRESS evidence verifier must equal owner_authority_id; also binds
  last_evidence_key ↔ PROGRESS evidence_ref ↔ ledger digest (P15.1 progress
  semantics) ↔ latest OBJECTIVE_PROGRESS event metadata {kpi,value,verifier,key}.
- `objective-operating-loop.ts` §6: pass computes allTargetsMet from kpi.current;
  MET → TARGET_MET_CANDIDATE + owner_action_required (never auto-ACHIEVED).
- Chain: objective_workstream_binding.workstreams[] = {workstream_key, work_item_id}
  → work_item(DC_*, status DONE after canonical fold, has objective_id+business_id)
  → business.boundMissionForWorkItem(child) → mission.bound_open_id →
  work_open_binding(work_item_id, business_id, state) → mission COMPLETED via
  assertCanonicalMissionCompletion → artifact rows {state ACCEPTED, mission_id,
  governed_task_id, execution_id, sha256} (mission_id ON row → attribution).

## Design (authority contract extension, NOT bypass)

1. `objective_kpi_auto_authorization` (KVA_ entity) — owner-scoped grant:
   objective_id+business_id+kpi_id+owner_authority_id pinned; rule
   {rule_type:"DELIVERABLE_BUNDLE", required_count?, required_keys?[]};
   progress_value (default 1); objective_terms_version pin (drift → deny);
   expires_at required; ENABLED→DISABLED/REVOKED/EXPIRED; ONE enabled grant
   per (objective,kpi); create/revoke owner-only.
2. `kpi_verification_receipt` (KVR_ entity) — immutable verification receipt:
   binds objective+kpi+auth+rule digest+verified units
   [{workstream_key,work_item_id,mission_id,artifact_ids[]}]+progress_value+
   terms_version; receipt_digest = digest(all bound fields);
   produced_by="PAIR_KPI_VERIFIER".
3. New verifier kind `kpi-verifier:<authorization_id>` + writer identity
   `PAIR_KPI_VERIFIER`. evidence_key = `kva:<auth>:<receipt_id>` — replay
   idempotent via P15.1 ledger; same key different semantics → existing
   FAIL_CLOSED_OBJECTIVE_EVIDENCE_CONFLICT.
4. `ObjectiveKpiVerificationService` — grant/revoke/status/verifyAndRecord.
   Chain eval per workstream unit: child DONE + objective/business scope +
   boundMissionForWorkItem + assertCanonicalMissionCompletion + ≥1 ACCEPTED
   artifact bound to that mission (row mission_id + governed_task linkage).
   Rule satisfied iff verified ⊇ required_keys && verified.length ≥
   required_count → write receipt + recordProgress inside same store
   transaction (atomic, revalidated).
5. `assertOwnerVerifier` extension: `kpi-verifier` kind → re-validates grant
   (ENABLED, unexpired, terms pin, objective/kpi/business scope) + receipt
   (exists, digest recompute matches, produced_by==PAIR_KPI_VERIFIER) — actor
   must be PAIR_KPI_VERIFIER. P15.5 strict check same re-validation. Owner
   path unchanged.
6. Integration: `runPass` calls `deps.kpiVerification?.advance(objectiveId)`
   right before §6 allTargetsMet — bounded per pass, no new scheduler/CEO.
   MC route /api/vnext/objectives/:id/kpi-verification {grant|revoke} owner-scoped.

## Fail-closed map (adversarial coverage)

forged/unaccepted/tampered artifact → state/sha/mission binding fail;
cross-mission/business → scope asserts; completed-but-criteria-unmet → rule
unsatisfied (no write, stays UNVERIFIED); executor self-report → verifier kind
rejected; replay → ledger idempotent; key reuse different semantics → conflict;
two workers → same txn serialization + same digest → idempotent; revoke mid-way
→ grant re-check in commit txn; terms drift → terms_version pin deny; terminal
→ assertNotTerminal; no grant → owner-verifier deny; non-deliverable KPI →
rule_type whitelist rejects at grant create.
