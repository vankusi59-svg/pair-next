# PAIR NEXT — MASTER MISSION CHECKPOINT (P15.10→P18)

updated: 2026-10-24T02:50Z
repo: vankusi59-svg/pair-next @ staging/pr59-safe
program_BASE: cad17a296f3bcf35a65e28e9e5749bc558014550

## STATUS

- PR #134 open: feat/p15-9-owner-seams-p16a → staging/pr59-safe (HEAD 55edffb, R3 PASS)
- PR #135 open: feat/p16-b-reasoning-brief → feat/p15-9-owner-seams-p16a (HEAD 47be280, R2 PASS)
- PR #136 open: feat/p16-c-ceo-brief-consumption → feat/p16-b-reasoning-brief (HEAD 4c29bf2, R3 PASS)
- PR #137 open: feat/p16-d-chat-read-grants → feat/p16-c-ceo-brief-consumption (R2 PASS)
- Step 0 (P15.9 owner-action gaps): DONE — HEAD 3616737840a6b2ff86d7c69be466357d649f7d1d
  - POST /api/vnext/objectives/:id/{progress,evidence,amend} — x-operator-id only authority
  - accountBudget intentionally NOT exposed (no assertOwner — pipeline seam)
  - UI: ObjectiveDetail owner actions + KPI verifier grants card; api.ts 4 wrappers
- Step 1 (P16-A Brain Context Aggregator ms1): DONE — same commit
  - src/pair/brain-context.ts — read-only, owner-gated, strict, bounded, deterministic
  - sections + sources/unavailable/integrity + context_digest; asof excluded
  - memory/experience = SCOPE_BINDING_ABSENT (P17 tenancy prerequisite)
  - library-only, no server/UI wiring
- Verdict: READY_FOR_INDEPENDENT_AUDIT (HIGH risk; full suite PASS_WITH_KNOWN_BASELINE +138 win32)

## PENDING

- P16-B ReasoningBrief contract: DONE — PR #135 (47be280); ReasoningBriefService.briefFor
  deterministic from contextFor; provenance from integrity notes; volatile-stripped digest;
  options name existing authority channels only; reasoner = transport+usable gates reported
- P16-C CEO consumption via ceo-planning-cycle injection (no ceo-decision schema change): DONE — PR #136
- P16-D verified-identity seam (operator/telegram scoped chat reads): DONE — PR #137;
  canonical conversation_read_grant, owner-claim+admin mint lanes, UNVERIFIED_IDENTITY stays default-deny
- Capability-gap advisory (DRIVER_* fault classification → persisted projection): remaining P16 item
- P17: business_id/objective_id tenancy scope on experience/memory (schema migration) → Brain consumption
- P18: objective_relation entity → portfolio → parallel → handoff → duties → recovery → company E2E

## DEFERRED P15 ISSUES

- 138 win32 test baselines (symlink EPERM, tsx.CMD spawn, D:\D: paths, chmod, /proc/self/fd)
- P15.10 driver OFF by default (PAIR_OBJECTIVE_AUTO_DRIVER=1) — operational opt-in
- objectiveCockpit UI: Capability Gap display absent (planned P16-D surface)

## NEXT ACTION

P16 remaining: capability-gap advisory (DRIVER_* fault classification → persisted projection).
Also: PRs #134–#137 all await owner merge — each PR's base must retarget to staging/pr59-safe
as its predecessor merges (stacked chain).

---
## R1 REPAIR CHECKPOINT (2026-10-24)
- Commit: ceca52615e21fdb577cce2db8ab267744e6084d2 (amends/extends 3616737 on staging/pr59-safe local)
- Diff audited: cad17a2..ceca526
- verify:change: READY_FOR_INDEPENDENT_AUDIT — claim 4/4, invariants 2/2 (+3 baseline), affected regression 11/11 (+13 baseline), tsc+build PASS, full suite PASS_WITH_KNOWN_BASELINE (+138 win32 baselines)
- Review findings fixed: M1 operator-identity edge (canonicalOperatorActor/operatorRef at every mint+actor edge; garbage owners unmintable/unclaimable), M2 digest determinism (clock-derived status fields stripped from digest input; B1b), M3 HTTP seam tests (pair-p15-9-step0-owner-actions.test.ts, 6 scenarios), minors (typeof-strict value, required evidence_key, owner-console source, empty-patch amend rejected at service layer, UI diff-only/strict-date/REVOKED, direct KPI/budget re-proof B1d, nested-budget FAIL_CLOSED_BRAIN_BUDGET B1c, hash footprint B7)
- Env note: C: drive hit 100% from accumulated pair-* test tmpdirs (2761 dirs ≈27GB) — cleaned; full-suite "unaccounted failures" were SQLITE_FULL, not code. Recheck disk before future full-suite runs.
- Next: rerun codex-reviewer on cad17a2..ceca526; if PASS → feature branch + PR; then P16-B.

---
## R2/R3 REPAIR CHECKPOINT (2026-10-24)
- Commits: 5feb87b (R1 repair) + ab58144 (R2 repair) + pending hygiene commit
- R2 reviewer verdict: NEEDS_FIX → all findings repaired; R3 verdict: **PASS** (only minor/trivial findings)
- R3 minors fixed in hygiene commit: empty-key/null-sentinel collision (M1″), digest() non-canonical patch 500 (M2″), dedup-window + authz-order doc notes (M3″/M4″), amend-patch owner gate test (M5″), vacuous all-undefined patch rejection (M6″), UI op-signature ':' collision → JSON.stringify (M7″), api.ts dead source field (M8″)
- Full suite PASS_WITH_KNOWN_BASELINE maintained; win32 baselines identical on BASE
- Next: verify:change on final diff → feature branch + PR → P16-B ReasoningBrief

## P16-C — CEO consumes ReasoningBrief (COMPLETE 2026-10-24)
- PR #136 `feat/p16-c-ceo-brief-consumption` → `feat/p16-b-reasoning-brief` (stacked on #135). HEAD `4360a67`.
- Seam: `CeoObservationDeps.brain_brief?` attaches `briefObservationView` inside `observation_digest` — cycle identity/replay/drift all bind brief content. Read identity = assertOwnerAuthorityRef-validated canonical owner.
- Degradation contract (R1-MAJOR fix): seam IntegrityErrors → deterministic `BRAIN_BRIEF_UNAVAILABLE` marker (code-only) — advisory surface can NEVER wedge runCycle/replay; non-IntegrityError propagates.
- Contract shift: mid-flight mutation visible only via brief → STALE at cycle boundary (was P15_5_STALE_REVIEW at review layer); p15-5 test 18 updated, zero-commit invariant unchanged.
- verify:change --base adf68c0 → READY_FOR_INDEPENDENT_AUDIT. Tests 14/14 + regression green. Review: R1 NEEDS_FIX→repaired, R2 PASS, R3 PASS.
- P16 remaining: P16-D verified-identity (operator/telegram scoped chat reads — Phase-5 seam, UNVERIFIED_IDENTITY stays default-deny by design).

## P16-D — verified read grants (COMPLETE 2026-10-24)
- PR #137 `feat/p16-d-chat-read-grants` → `feat/p16-c-ceo-brief-consumption` (stacked on #136). Commits: `07da74a` feat, `1763e40` R1 repairs, R2 hygiene.
- `conversation-read-grant.ts`: canonical grant entity — principal_ref (telegram:<chat>/operator:<id>) × explicit scope {objective_ids, business_ids, own_footprint} + operator_ref + expiry (90d max TTL) + terminal disable/revoke + digest pin (incl. state/dedup_key) + event anchors + idempotent mint.
- Mint lanes: admin credential (any scope) or operator claim (same authority as vnext owner actions — own operator_ref + provable scope only). Enforcement: operational-query `readGrants?` seam — granted principals read exactly vouched scope; providers/executors stay INSUFFICIENT_AUTHORITY; ungranted/expired/revoked/forged/resurrected principals stay UNVERIFIED_IDENTITY. Zero writes on read path.
- HTTP: /api/conversations/read-grants* inside adminBoundary; status visibility scoped (no cross-principal enumeration); AUTHORITY→403 code-only (no foreign-id leak).
- verify:change --base 4c29bf2 → READY_FOR_INDEPENDENT_AUDIT. Tests 22/22 + regressions green. Review: R1 PASS (6 minors repaired), R2 PASS.

## P16-E — capability-gap advisory (COMPLETE 2026-10-24)
- PR #138 `feat/p16-e-capability-gap` → `feat/p16-d-chat-read-grants` (stacked on #137). Commits: `9dd30f8` feat, `a8395df` R1 repairs, `06cbda3` R2 repairs, `21e40a4` R3 repairs, `2721971` R4 polish.
- `objective-capability-gap.ts`: canonical `objective_capability_gap` row per objective — typed DriverDenial → closed classification (label → gap_kind + owner_action), transient/permanent, bounded evidence ring (8), occurrences, digest + column-version OCC + OPENED/RESOLVED event anchors. Settled pass → RESOLVED. recordGap idempotent per (label,fence).
- Fail-closed re-proof (read AND write): digest, identity binding (objective_id/entity_id), column-version (never payload-sourced), newest lifecycle event must agree with state + label + permanence. Unproven → UNVERIFIED marker or self-healing mint — never wedges, never launders forged internals (resolveGap returns proven-or-null).
- Recovery classes closed: corrupt payload, corrupt tail event, TEXT/REAL version columns, payload-version skew, secret-shaped digest fields, state-consistent label/permanence swaps, free-text timestamps — all UNVERIFIED-or-healed (raw-SQL probes G14–G28).
- Driver seam advisory-only: every call site try-wrapped + onGapFault observability hook; status()/statusReadOnly() zero-write; unwired deployments expose gap=null. UI rides existing owner-gated auto-driver status fetch — open/resolved/UNVERIFIED advisory rows, closed vocabulary only.
- verify:change --base 77ed19c → READY_FOR_INDEPENDENT_AUDIT. Tests 28/28 + regressions green (P15.10×186, P16-A..D 62). Review: R1 NEEDS_FIX (4 majors)→repaired, R2 (3 majors)→repaired, R3 (3 majors)→repaired, R4 PASS (2 minors polished).
- Honest residual documented in file header: rows-only writers can still rewrite unjournaled recurrence detail (counts, evidence beyond pinned label/permanence); event-writers can fabricate anything — inherent store bound.
- P16 milestone set complete (A brain-context, B ReasoningBrief, C CEO consumption, D verified read grants, E capability-gap advisory). Next: P17 business/objective tenancy for experience/memory, then P18.

## P17 — tenancy scope for experience + memory (COMPLETE 2026-10-24)
- PR #139 `feat/p17-scope-tenancy` → `feat/p16-e-capability-gap` (stacked on #138). Commits: `f000db5` feat, `755acf7`/`b0cdd77` R1 repairs, `d0f9a47` R2 polish.
- Experience v2: `createCandidate` canonical-validated `scope_objective_id`/`scope_business_id` (business derived from objective's own, foreign pairing → FAIL_CLOSED_EXPERIENCE_SCOPE; both null = UNSCOPED). `retrieve()` symmetric tenancy admission BEFORE ranking — objective query → objective+business-shared (business canonically derived when omitted, unresolvable → nothing), business query → business-shared only, unscoped query → UNSCOPED only. `scopedFor()` honest counts (unscoped/out_of_scope/ineligible). `findBySeriesKey` scope-strict; fold() normalizes obs scope before dedup.
- `deriveMissionScope` (exported, shared): mission.bound_open_id → binding (mission+business cross-checked; disagreement drops objective claim) → work_item → root walk → root's OWN canonical objective_id/business_id (re-proved vs objective row). Unresolvable links degrade, never fabricate.
- R1-MAJOR closed: routing+planner advisors resolve mission tenancy → retrieve — foreign-scope rows can never advise another scope's mission (T11/T12, real bound mission).
- MIGRATION_V13 scope columns on model-writable memory (legacy rows stay UNSCOPED); writers require both columns, upserts COALESCE-preserve scope. `ScopedMemoryReader`: SQL-bounded admission (32/table), deterministic, 512B cap, honest counts, schema-tolerant.
- Brain consumes deps seams (unwired → *_NOT_WIRED); brief emits EXPERIENCE (PROJECTED) + MEMORY (UNVERIFIED) only on real content. Deps forwarded through ceo-runtime/loop/adaptive-review; serve-mission-control wires ScopedMemoryReader(automaton.raw)+experience under auto-driver composition.
- verify:change --base 77cb4d9 → READY_FOR_INDEPENDENT_AUDIT. Tests 13/13 + regressions green (P4/P7/P8/P9 220, P16-A/B/C 40, memory 232, p15-1/6+subscription-ceo 203). Review: R1 NEEDS_FIX (1 major)→repaired, R2 PASS (3 nits folded).
- Next: P18 objective_relation entity → portfolio → parallel → handoff → duties → recovery → company E2E.

## P18-A — canonical objective_relation (COMPLETE 2026-10-24)
- PR #140 `feat/p18-a-objective-relation` → `feat/p17-scope-tenancy` (stacked on #139). Commits: `dcd25c0` feat, `1355ada`/`bab7630`/`0d4a69d`/`4f7c387`/`2ed1429`/`197ec91`/`f1a80a9` R1–R7 repairs.
- `ObjectiveRelationService`: DEPENDS_ON/CONFLICTS/SUPERSEDES between same-business objectives; ACTIVE→SUSPENDED⇄ACTIVE→REVOKED (terminal, idempotent); closed kind+action vocabularies. Bilateral authority: actor = owner_authority_id of BOTH endpoints at mint/control AND created_by re-proved against CURRENT owners on reads (amended endpoint drops the relation). DEPENDS_ON acyclicity at mint AND RESUME over non-REVOKED edges. create()/control() inside store.immediate — dedup/cycle+put+event atomic, cross-connection serialized. Dedup after authority, per (from,to,kind) non-terminal, CONFLICTS symmetric.
- STRICT/LENIENT re-proof split (core hardening): writes enumerate strict — corruption of any kind (entity hash/key/version, event tail, endpoint payload, store fault) propagates loudly so a corrupted-but-real row can never silently truncate dedup/acyclicity into dup mints or admitted cycles; reads enumerate lenient — corrupt rows isolate-and-skip, siblings serve; semantic unproven-ness (fabrications, broken chains) returns null in both modes so plants can't DoS mints. Budget trips always propagate.
- store.ts integrity taxonomy: all 7 parse sites (entityPage/get/list/verifiedEvent/listEvidence/planRevisions/listAllRaw) classify unparseable + non-object (null/primitive/array) + undigestable (1e999, pathological nesting) payloads as typed *_HASH_MISMATCH with key — was bare SyntaxError/TypeError/Error crashes; also unblocked auto-wakeup's retryable-fault cursor on corrupt metadata.
- Reads re-prove: digest + entityPage storage-key↔payload binding + strict objectives + business + bilateral current-owner + FULL event tail (CREATED identity pins + new_state=ACTIVE + old_state=null, legal chained STATE hops ending at row state). upstreamOf/conflictsWith dedup'd, deterministic order — the P18-C admission seams. INERT: no admission/scheduling/UI consumer.
- verify:change --base ba17076 → READY_FOR_INDEPENDENT_AUDIT on f1a80a9. Tests 26/26 (raw-SQL forge/corruption probes); blast radius green (p15-9a 28, p15-10b/r1 23, p16-a..e 90, phase-d 37, +more). Review: 7 adversarial rounds — R1 4 MAJOR → R2 1 MAJOR → R3/R4/R5/R6/R7 1 MODERATE each → R8 PASS.
- Documented bounds: deletion+verbatim-restore is fabrication-indistinguishable (dup/cycle lane, dominated by no-MAC bound); CYCLE_DEPTH_CAP bounds work not depth; owner amend drops relations (fail-closed, re-mintable).
- Next: P18-B portfolio — business-level projection over relationsForBusiness; then P18-C parallel gating consuming upstreamOf/conflictsWith.

## P18-B — business portfolio projection (COMPLETE 2026-10-24)
- PR #141 `feat/p18-b-portfolio` → `feat/p18-a-objective-relation` (stacked on #140). Commits: `bdb44fd` feat, `d77e536` R1 repairs, `9a77c1f` R2 polish.
- `ObjectivePortfolioService.businessPortfolio` — READ-ONLY advisory projection, zero writes reachable. Scope proof via new `ObjectiveAuthorityService.strictEnumerate` (persisted-key entityPage enumeration + strict get + payload identity, org-wide fail-closed — extracted verbatim from cockpit.businessCompany, code → FAIL_CLOSED_OBJECTIVE_IDENTITY). Only proven edges with BOTH endpoints actor-owned project. Per-objective depends_on/dependents/conflicts/supersedes/superseded_by (all states, code-unit order, counterparty_objective_id) + dependency summary (SATISFIED/PENDING/FAILED, blocked=pending+failed>0) + active_conflicts; counts over the FULL scoped set before the 200-page. Route GET /api/vnext/businesses/:id/portfolio — NO read-budget wrap (parity with unbudgeted /company; the {1024,512} scheduler budget org-wide-charged at ~half bound for every actor — R1 MAJOR-1 reproduced). FAIL_CLOSED_PORTFOLIO_SCOPE → 403 code-only.
- verify:change --base 1ddcd9d → READY_FOR_INDEPENDENT_AUDIT on 9a77c1f. Tests 10/10 (+B9 route boundary, B10 205-objective truncation); regressions green (cockpit 28, p18-a 26, p15-1 66). Review: R1 NEEDS_FIX (1 MAJOR reproduced)→repaired, R2 PASS.
- Documented bound: non-transactional mixed snapshot (stale-owned render possible, edges can never leak — re-proof is current-owner at relation-read).
- Next: P18-C parallel gating — DEPENDS_ON/CONFLICTS admission constraints consuming upstreamOf/conflictsWith.

## P18-C — parallel admission gating (COMPLETE 2026-10-24)
- PR #142 `feat/p18-c-parallel-gating` → `feat/p18-b-portfolio` (stacked on #141). Commits: `bb164ef` feat, `382839c` R1 repairs, `5156ea9` R2 repairs, `8e21370` R3 repairs, `a516cb4` R4 polish.
- `ObjectiveRelationService.admissionView` — STRICT ACTIVE DEPENDS_ON upstreams + CONFLICTS partners: corrupt rows propagate loudly (corrupted-but-real edge can never silently clear admission), semantic unproven-ness (forged/owner-amended) drops so fabrication never gates. Shared `relationGate` wired at all three claim seams: claimable() (read-only, reasons UPSTREAM_UNMET/CONFLICT_LEASE_HELD; roster mirror now invalid()s missing lease rows like activeRoster), nextFairCandidate() (transient skip — furthest advances, one activeRoster snapshot per scan), claim() (gate LAST before mint — atomic with roster under the same immediate tx; retry-exhausted marker ordering preserved).
- DEPENDS_ON: any ACTIVE upstream not ACHIEVED gates (pending AND terminally-failed — owner action only). CONFLICTS: mutual exclusion via live-lease roster. Admission-only: mid-execution relation mint never kills a live lease; settle/renew/assert untouched; manual/operator admission unaffected.
- O(degree) edge index (R1-F1 self-DoS repair): `objective_relation_index` pointer rows keyed `OBJ:REL` — pure table projection, proof-AGNOSTIC (R3-F1: a row unproven AT REBUILD TIME — owner amend flip-flop — keeps its pointer and re-gates on re-proof; proven-only indexing hid it forever). Named relation still fully strict-re-proven at read; dangling/tampered/key-borrowed pointers wedge FAIL_CLOSED_RELATION_INDEX. Resumable chunked rebuild (INDEX_CHUNK=64, marker `objective_relation_index_state:progress` — R2-F1: `built` only after the COMPLETE bound set, never on a chunk-cut short page). claim()/nextFairCandidate() advance ensureIndex in their OWN committed tx (progress survives gate wedges); claimable() read-only falls back to identical strict global enum while marker un-built.
- verify:change --base a016940 → READY_FOR_INDEPENDENT_AUDIT on a516cb4. Tests 13/13 (C1–C13 incl. raw-SQL probes, chunk boundary, owner flip-flop); regressions 343/343 (p15-10 group, p18-a/b, p15-9a, p15-1). Review: R1 1 HIGH → repaired, R2 1 HIGH+2 LOW → repaired, R3 1 MEDIUM → repaired, R4 PASS.
- Next: P18-D cross-objective deliverable handoff, P18-E org-agent duties, P18-F recovery + company E2E.

## P18-D — cross-objective deliverable handoff (COMPLETE 2026-10-24)
- PR #143 `feat/p18-d-deliverable-handoff` → `feat/p18-c-parallel-gating` (stacked on #142). Commits: `31711f3` feat + `d0e8a00` upstreamed R1 probes.
- `eligibleSourcesForWorkItemScope()` (artifact-handoff.ts) — authorized objective set = {consumer objective} ∪ direct ACTIVE DEPENDS_ON upstreams via `admissionView(objectiveId).upstream` (the SAME strict seam the scheduler gate uses). Each authorized objective re-proven: canonical get + business_id === consumer allocation business. DEPENDS_ON only — CONFLICTS/SUPERSEDES/SUSPENDED/REVOKED/transitive never authorize; each hop needs its own bilateral-owner edge.
- All downstream proofs unchanged: per-allocation authority re-proof, bound-mission provenance, ACCEPTED-artifact + anchored PASS validation, exact artifact identity + CAS bytes. Single canonical listEligibleExternalInputSources seam feeds pin/resolve/dispatch re-proofs — assertCrossMissionEligibleNow closes revoke-after-pin at the byte boundary.
- verify:change --base b246a90 → READY_FOR_INDEPENDENT_AUDIT on d0e8a00. Tests 11/11 (D1–D11 incl. transitive exclusion, index/fallback parity, revoke-after-pin). Review: R1 PASS first round (14 probes; MINOR/TRIVIAL only, all fail-closed: index-vs-fallback wedge asymmetry, semantic-unproven marker bound, widened allocation-DoS scope, deleted-endpoint silent de-auth, discarded conflicts read).
- Next: P18-E org-agent duties spanning objectives, P18-F recovery + company E2E.

## P18-E — canonical org_agent_duty (PR #144)
- `feat/p18-e-org-duties` → stacked on `feat/p18-d-deliverable-handoff` (#143). HEAD `ba4a8ff`.
- Canonical `org_agent_duty`: agent ↔ sorted-unique objective set, one business; N-lateral owner consent (actor = current owner of EVERY covered objective); ACTIVE→SUSPENDED⇄ACTIVE→REVOKED via canonical events; digest + storage-key/entity binding + full event-tail re-proof.
- Reads: `dutiesForObjective`/`dutiesForAgent`/`coveringDuties`/`covers` — no union of partial duties; `covers` needs ONE proven ACTIVE duty over the full set.
- Indexes `org_agent_duty_index` (O:/A: pointer rows) + chunked resumable rebuild (marker only after complete scan); proof-agnostic pointers; corrupt → FAIL_CLOSED_DUTY_INDEX, poison → isolate-and-skip.
- Endpoint keyability gate (no ':' ids → unforgeable index keys); sentinel-free `startsWith` prefix scans (astral keys included — R4 parity fix applied to relation index too).
- verify:change READY_FOR_INDEPENDENT_AUDIT; review R3+R4 PASS. 18/18 focused, 15/15 p18-c (C14/C15 parity regressions).

## P18-F — supersession-aware recovery + company E2E (PR #145) — P18 SERIES COMPLETE
- `feat/p18-f-recovery` → stacked on `feat/p18-e-org-duties` (#144). HEAD `19e2735` (feat `3ac3124` + R1 `e3fb36f` + R2 `19e2735`).
- `admissionView` gains `superseded_by` (proven ACTIVE SUPERSEDES to==id, index+fallback identical). Scheduler `upstreamSatisfied`: BFS over the proven supersession DAG, cycle-safe, SUPERSEDE_WALK_CAP=128 — satisfied iff ANY reachable node is ACHIEVED. Failed upstream + achieved declared replacement releases admission; pending upstream + achieved replacement releases too (same authority class as revoking the edge).
- R1 MODERATE fixed: mid-walk PROOF_LIMIT contained as unmet (was: unguarded relationGate throw → proof() rollback → fairness cursor frozen → global-scan livelock). Scan's gate call now under stoppedOnBudget guard like queue()/lease(). Cap-trip drains already-seen nodes (any in-window node can satisfy).
- Boundaries: handoff keeps raw upstream (no provenance expansion), duties keep declared coverage, CONFLICTS unaffected, superseding the dependent itself is lineage not a lease gate, portfolio raw-status satisfaction = recovery-unaware advisory (documented). Root admissionView budget trips still propagate typed in claimable/claim.
- verify:change READY_FOR_INDEPENDENT_AUDIT (base 9b0e986). Review: R1 1 MODERATE+4 LOW → repaired, R2 PASS. Tests F1-F15 15/15; regressions 376+306 green.
- P18 series status: A #140 → B #141 → C #142 → D #143 → E #144 → F #145, all READY_FOR_INDEPENDENT_AUDIT, all adversarial-reviewed to PASS, owner-merge pending throughout.

## MERGE COMPLETE — 2026-10-24 (owner-authorized)
- All 12 stacked milestone PRs merged sequentially into `staging/pr59-safe` (#134-#145), each retargeted to staging before merge to preserve per-PR merge records.
- `staging/pr59-safe` → `main` via PR **#146** (`d0d50dd`): the complete P16-P18 governed autonomy program now lives on the repo default branch.
- Open PRs remaining: 0. Merged: #134-#146.
- Local feat/* branches remain for archaeology; remote feature branches left undeleted (owner may clean).

## Semantic & Context-Aware Planning V1 — feat/semantic-context-planning-v1 (READY_FOR_INDEPENDENT_AUDIT 2026-10-26)
- BASE `46b05bf` (main @ P18.4 #153 merge) → HEAD `b2e85b5`, 7 commits. Plan: `docs/plans/2026-10-26-semantic-context-planning-v1.md` + architecture map (codex-planner review verdict SOUND_WITH_ADJUSTMENTS, M1–M8 applied).
- `PlanningContextEnvelope` (`src/pair/planning-context.ts`): advisory evidence class only — CANONICAL/PROVEN/PROJECTED/UNVERIFIED sections, volatile-stripped digest, ≤4096-char render. Assembled lazily at the two async seams (`planExpander`, `runReplanPoolGeneration` via `invokePlannerPool`); replan pins `planning_context_block`+digest on the durable `replan_generation` row; fresh paths render live. Assembly failure → context-free planning, null evidence. Never bound into `plan_digest`/`effective_input_digest`.
- Deterministic EN/VI extension (`goal-contract.ts`): outcome verbs (grow/tăng/đạt/thu hút…), grouped quantities (`1,000`/`1.000`), relative deadlines (`within N days`/`trong vòng N ngày`), `without`→prohibition, guarded comma split.
- Coverage (`plan-coverage.ts`): outcome obligations need fulfillment-verb tasks — preparation verbs (research/write/draft…) can never satisfy "grow a channel"; quantity floor compares magnitudes; `assertPlanCoverage` remains sole authority, `pair_coverage` stays advisory (forgery/non-claimable → fail closed).
- Evidence: coverageSink per attempt → sanitized PlanCoverageReport on planner_attempt → copied to preview row → `/api/plan-previews/:id` + preview response + read-only MissionNew UI block.
- Both transports share the canonical prompt builder; `planningContextBlock`+`rejectionContext` threaded identically; codex strict schema carries no advisory props. Zero new provider invocations (cost envelope untouched).
- Tests: 9/9 context + 13/13 coverage + 20/20 adversarial (H1–H20) + 244/244 planner regression sweep.
- Real-model E2E (codex AUTH_OK, `scripts/dev-verification/semantic-real-e2e.mjs`): `2_PASS_3_FAIL_CLOSED_0_OTHER`; E2E-2 demonstrated INITIAL:FAIL_CLOSED → REASK:CANONICAL_PASS governed retry; remaining fails are correct conservative governance (unbound dataflow, unauthorized network source, prohibited-term). Report: `docs/e2e-semantic-v1/REAL_PLANNER_E2E_REPORT.*`.
- verify:change --base 46b05bf → **READY_FOR_INDEPENDENT_AUDIT**: claim 14/14, invariants 9/9, regression 48/48, TSC+BUILD PASS, full suite PASS_WITH_KNOWN_BASELINE (+133). NOTE: run requires ambient `PAIR_DSH_*`/`AGNES_API_KEY`/`PAIR_PLANNER_*` host env unset — ambient env adds 2 env-driven p5 failures over baseline budget (harness/host-env interaction, not production).
- Windows baselines confirmed: covmap T9/T11 `.cjs` spawn EFTYPE; p5 `.local` PATH-mask misses `AppData\Local`; win32 /proc/self/fd artifact baselines — all verified BASE==HEAD.
- Next: K′ three-scope independent audit → owner-reviewable PR (no auto-merge).
- K′ audit (independent, 3 scopes) → FIX-THEN-SHIP: remediated 3 HIGH (đ/í dead boundaries → vacuous coverage closed; marker-path grouped-quantity collapse; temporal-number floors both directions), 3 MED (VI initial anchors, render≠evidence bound, trailing-connective unplannable), 4 LOW (without term leak, reask staleness, UI guard, stale comment). Probes: SC-10..19, H8→≤4096, PC-10/11.
- Post-remediation re-verify → READY_FOR_INDEPENDENT_AUDIT at `7efcc33`. PR #154 open, owner-review pending, NO auto-merge.
- K″ final audit (owner-requested, HEAD 0a4e204): found + fixed last Unicode-boundary defect class — `giờ`(ờ)/`không quá`(á)/`chỉ`(ỉ)/`ngoại trừ`(ừ)/`cục bộ`(ộ)/`dữ liệu`(ệ)/`kết quả`(ả)/`đọc`/`và`/`sau đó` edges dead under ASCII `\b`. `trước 10 giờ`/`trong vòng 30 giờ` now mint deadlines; duration numbers masked contract-AND-task-side; ceilings can no longer invert into floors. Probes H21–H37 (37/37 green). Sweep: `scripts/dev-verification/b-boundary-sweep.cjs`. Re-verified @ `fa78955` (code-final; pushed HEAD `e6912c1` = docs/claim-only delta) → READY_FOR_INDEPENDENT_AUDIT. PR #154 remains open — no merge without owner authorization.
- Final verification mission: full-scope `verify:change --base 46b05bf` @ `613a715` → READY_FOR_INDEPENDENT_AUDIT (claim 16/16+22, invariants 9/9+3, regression 48/48+40, TSC+BUILD PASS, full suite +133 baseline). Controlled env: ambient PAIR_DSH_*/AGNES_API_KEY unset + TMP→D: (C: had hit ENOSPC from ~20GB leaked pair-* mkdtemp dirs — post-merge hardening item). Independent 3-scope merge-readiness audit of 46b05bf..HEAD in flight. PR body synced. Docs record verified-vs-final HEAD correspondence via file-level diff.
