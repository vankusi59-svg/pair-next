# PLANNER CONTRACT SIMPLIFY — Report

Mandate: remove `network_requirement` + `pair_coverage` from the mandatory
model-facing contract. PAIR owns canonical metadata derivation, validation and
normalization; the planner is responsible for the semantic core only —
`task_key`, `task_instruction`, `depends_on`, `required_capabilities` (when a
capability has a real semantic role). Fail-closed stays for real
authority/security. Minimal fix using existing seams.

- Branch: `devin/1791261163-planner-contract-simplify`
- BASE: `e750d86` (main HEAD post-PR#52 merge)
- HEAD: (see commit below)

## Planner-facing contract — BEFORE → AFTER

| field | BEFORE | AFTER |
|---|---|---|
| `task_key` | required | required |
| `title` | required | required |
| `task_instruction` | required | required |
| `required_capabilities` | required (model had to name NETWORK_ACCESS itself) | required — PAIR owns the NETWORK_ACCESS bind; a claim is advisory routing metadata only |
| `depends_on` | required | required |
| `pair_coverage` | **required** — missing/misplaced map killed the plan (`FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED`) | optional **hint/evidence** — never authority |
| `network_requirement` | **required** structured field; missing/malformed/bad-locator/`UNKNOWN`+REQUIRED/`LOCAL`+filename-locator all killed the plan (`FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID`) | optional advisory annotation — never validated, never authority |

## REMOVED (dead model-facing burden)

- `FAIL_CLOSED_PLAN_COVERAGE_UNDECLARED` gate in `plan-coverage.ts` — a plan
  can no longer die because a requirement was *performed* but not *declared*.
  Replaced by a hint-explanation comment; `extractReaskDetail`'s
  UNDECLARED case in `planner-pool.ts` deleted.
- Fresh-emission `network_requirement` validation classes in
  `serve-planner.ts` — `REQUIREMENT_MISSING`, `REQUIREMENT_MALFORMED`,
  `BAD_LOCATOR`-style locator shapes, `UNKNOWN`+REQUIRED and
  `LOCAL`+filename-locator annotation errors can no longer kill a fresh plan.
  The planner's structured field is consumed as a hint only.
- Codex `PLAN_SCHEMA` `required` list entries for `pair_coverage` +
  `network_requirement` (`codex-planner.ts`); both fields remain permitted
  properties so older emissions still parse.
- Prompt burden (`llm-planner.ts`): `network_requirement` demoted to
  "OPTIONAL advisory hint only — PAIR derives each task's network requirement
  itself"; `pair_coverage` demoted to optional hint (a claimed-but-unperformed
  row is fabricated evidence and still fails); the NETWORK_ACCESS bullet now
  states PAIR binds it from instruction wording.

## STILL CANONICAL (unchanged authorities)

- `Goal Contract` extraction (`extractGoalContract`) — OBL/DEL/prohibition/
  constraint/delivery-intent still mined from the goal, untouched.
- `assertPlanCoverage` existential check — every obligation must be performed
  by some task (`taskCoversObligation`), every deliverable must be produced
  by some task (`taskProducesDeliverable`); missing work =
  `FAIL_CLOSED_PLAN_INCOMPLETE`. Fake coverage cannot mask missing work.
- `validateProposedCoverage` — a declared `pair_coverage` claim must still be
  OBL/DEL + genuinely `covers()` — fabricated claims still rejected; a
  bookkeeping claim on a non-producing task still rejected.
- Network authority: `resolveFreshTaskNetworkAuthority` (fresh) +
  `resolveTaskNetworkAuthority` (persisted, verbatim legacy-read path).
  Fresh failures that remain are *authority* failures, not annotation
  failures: instruction-named host ∉ goal-authorized hosts
  (`UNAUTHORIZED_SOURCE` under `FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID`)
  and `FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED` when PAIR derives
  REQUIRED but no servable `NETWORK_ACCESS` binding exists.
- `repairNetworkCapabilityBinding` — PAIR-owned: binds `NETWORK_ACCESS` iff
  derived REQUIRED + allowed + jointly servable vs executor capability sets;
  emits `REPAIRED_NETWORK_CAPABILITY:<key>`; planner claim on a
  NOT_REQUIRED task stays advisory and never creates authority.
- Telegram delivery intent authority, artifact identity/provenance (F4),
  secret governance, filesystem containment, dangerous capability grants,
  executor qualification, canonical DAG validity
  (`reconcilePlanDataflow`/`assertPlanDataflow` — order + acyclicity),
  delivery manifest integrity — all byte-unchanged.

## Incidental defects fixed (found by the new adversarial proofs)

1. `extractGoalHosts` URL regex `[^\s"'<>)\]]+` swallowed trailing
   punctuation — instruction `"...https://mql5.com, thu thập..."` produced
   host `mql5.com,` → subset check failed → `UNAUTHORIZED_SOURCE` on a
   legitimately authorized host. Now `raw.replace(/[.,;:!?]+$/, "")` before
   `new URL`/`requirementLocatorHost` (`network-requirement.ts`).
2. `contentTokens`/`sharesContentToken` tokenized on ASCII `[a-z0-9]+` —
   Vietnamese obligations (`tóm tắt mục đích dự án bằng tiếng Việt`) shattered
   into sub-3 fragments → zero content tokens → an obligation with no
   identity anchor could NEVER be covered → `FAIL_CLOSED_PLAN_INCOMPLETE`
   even on a correct plan (the real aquascope death class). Tokenizers are
   now `/[\p{L}\p{N}]+/gu` on both sides (`plan-coverage.ts`).

## Proofs (new adversarial suite `pair-planner-contract-simplify.test.ts`, 11/11)

- **E1 aquascope goal verbatim** — metadata-free 3-task plan (zero
  `pair_coverage`, zero `network_requirement`): PAIR repair binds
  `NETWORK_ACCESS` onto the fetch task (`REPAIRED_NETWORK_CAPABILITY:T1`),
  existential coverage passes, plan pins with PAIR bookkeeping; identical
  outcome through the real HTTP sanitize path (`llmPlan` stub).
- **E2 legacy emission shapes** — `EXTERNAL`+null locator (production
  gold-mission death shape), `LOCAL`+`gold_inputs.json`, `LOCAL`+`outbox/`,
  `UNKNOWN`+REQUIRED: all degrade to "no evidence", never kill; instruction
  wording decides; declaration cannot self-elevate.
- **E3 authority adversarial** — no-network executor policy: zero bind +
  `FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED`; TELEGRAM_DELIVERY claim
  under a goal that never asked: fail closed; fabricated `pair_coverage`
  cannot mask an unproduced deliverable (`FAIL_CLOSED_PLAN_INCOMPLETE`); a
  task's `depends_on` on a delivery task still dies
  `FAIL_CLOSED_PLAN_DATAFLOW_ORDER`; instruction-named host outside the
  goal's hosts still dies `UNAUTHORIZED_SOURCE`. Cycle-shaped `depends_on`
  normalizes deterministically (unjustified edges pruned at canon) and
  `assertPlanDataflow` confirms acyclic.

## Validation

- Focused (8 files): `pair-planner-contract-simplify` 11/11,
  `pair-network-requirement` 15/15, `pair-network-binding-repair` 10/10,
  `pair-network-requirement-r3` 11/11, `pair-covmap-coverage-map` 15/15,
  `pair-prv2b-goal-coverage` 52/52, `pair-prv2a-planner-modernization` 59/59,
  `pair-prv2b-prohibition-narrowing` 52/52 → **225/225**.
- Full suite: **3728 pass / 3 fail** — byte-identical baseline
  (`F4 R5.1-crash` + 2× P5 env: stock dsh/codex executables present on this
  host); 15 skipped. No baseline touched.
- `npx tsc --noEmit` clean; `npm run build` clean (`rm -rf dist` first).

## Explicit answers required by the mandate

1. **Can a correct semantic plan still die ONLY from a forgotten/wrong
   `network_requirement`?** — NO. On the fresh path the field is advisory
   and is never the rejection input. The only network failures remaining are
   semantic authority failures evaluated from instruction+goal, not from the
   field: `UNAUTHORIZED_SOURCE` (task's instruction names a host the goal
   never authorized) and `TASK_NETWORK_CAPABILITY_REQUIRED` (PAIR itself
   derived REQUIRED and no executor set can serve it — an executor-policy
   denial, not an annotation error).
2. **Can a correct semantic plan still die ONLY from `pair_coverage`
   bookkeeping?** — NO. The `UNDECLARED` gate is deleted; missing, misplaced
   or empty maps never reject. Remaining coverage failures are existential
   (`FAIL_CLOSED_PLAN_INCOMPLETE` — no task performs the obligation /
   produces the deliverable) or fabricated-evidence rejection of a declared
   claim — both semantic, not bookkeeping.

## Residual risks / limitations

- Planner `NETWORK_ACCESS` claims persist as advisory routing metadata —
  the executor-policy gate (`repair` + `TASK_NETWORK_CAPABILITY_REQUIRED`
  + dispatch re-proof) is what makes them non-authoritative; the claim is
  not stripped from the task record.
- Persisted-mission path keeps the legacy resolver verbatim
  (`provenance:"persisted"`) — intentionally isolated legacy-read; new
  semantics only govern fresh emissions.
- `subjectAnchors`/`externalSubjectKeys` remain ASCII-lean for anchoring
  (unchanged) — the unicode fix covers content-token fallback only.
- A plan whose tasks *require* network under an executor policy that serves
  none still fails closed by design (`TASK_NETWORK_CAPABILITY_REQUIRED`) —
  unchanged semantics, now PAIR-derived rather than planner-declared.
