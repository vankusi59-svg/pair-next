# PAIR OS vNext — V1.0.0 OFFICIAL FINAL Release Manifest

Release identity: **PAIR OS vNext V1.0.0** (`v1.0.0-pair-next-official-final`)

## Lineage

```
d8f8168  upstream Automaton baseline (clean, untouched)
→ 8ab970c  lab scaffold
→ 4aef764  P1  runtime foundation (de-Conway)
→ c9fc646  P2  control-plane seam (PAIR_NATIVE + GovernedTaskGate + evidence)
→ de46191  P3  routing authority (CapabilityRouter/Registry/RouteSelector/Ledger/MissionRouter)
→ bb9d0e8  P4  memory persistence (single pair-next.db, migrator, ExperienceService)
→ c6f59ac  P5  real multi-executor adapters (DSH ACP + Codex CLI)
→ e40bbdc  P5.1 real executor live qualification (DSH via Groq route, Codex ChatGPT OAuth)
→ 2ab56d0  P6  provider/model discovery + canonical catalogs
→ 8ab1736  P7  verified experience + bounded adaptive routing
→ 87c978b  P8  recovery controller + reconciliation + self-improvement governance
→ 3e2d499  P9  mission runtime loop + Mission Control + DEVIN executor (RTE_REMOTE_API)
→ bdbacec  P10 hardening fixes (restart-plan guard, MC operator boundary, tool-allowlist field)
→ 71cd1ab  P10 flake fix (capability-split approval isolation)
→ 23e4d57  P10 §10 context-hardening root-cause fix (tokenizer encode cap)
```

## Architecture authority

`PAIR_NEXT_SINGLE_MISSION_ROUTING_AUTHORITY` — MissionRouter is the sole mission/executor
routing authority. Automaton = WHAT/NEXT (planning). PAIR Governance (GovernedTaskGate) =
MAY-IT-EXECUTE. P6 Catalog = provider/model qualification authority. Verified Experience =
advisory only (score clamp ±40 inside eligible set). RecoveryController = bounded
recovery-decision authority. MissionRuntime orchestrates existing authorities only.
SelfImprovementController = isolated proposal/test/verification only. Operator = final
sensitive-approval/promotion authority.

## Components (src/pair, 50 modules / ~15.0k LOC)

Persistence (`pair-next.db` unified store), governed evidence (append-only, verify-on-read,
hash-chained), GovernedTaskGate (workspace/allowed_paths/permissions/requested_tools/capability/
qualification), CapabilityRouter + ExecutorRegistry + RouteSelector + RouteLedger + MissionRouter,
ProviderCatalog + ModelEvidenceCatalog + discovery sources + bounded tiered probing + model
bindings + routable projection, Experience extraction/verifier/advisors (planner + routing),
RecoveryController (24 failure classes, decision matrix, budgets, backoff, receipts),
ReconciliationService (5 outcomes, UNKNOWN_SIDE_EFFECT fail-closed), SelfImprovementController
(isolated git worktree, classifier, promotion only via OPERATOR_AUTHORIZED_PROMOTION),
MissionRuntime state machine, MissionSupervisor (wake reasons, fairness), MissionScheduler (DAG),
ApprovalQueue (scope-digest bound, TTL), MissionObservability, MissionControl backend +
node:http server + functional UI, executor adapters: PAIR_NATIVE, DEEPSEEK_HARNESS (ACP stdio),
CODEX (CLI/JSONL), DEVIN (REMOTE_API).

## Executor portfolio

| Executor | Transport | Live status |
|---|---|---|
| PAIR_NATIVE | in-process LocalWorkerPool bridge | LIVE QUALIFIED |
| DEEPSEEK_HARNESS | ACP stdio (`dsh --profile acp` @0.1.5-rc.3) | LIVE QUALIFIED (route `groq:openai/gpt-oss-20b`) |
| CODEX | `codex exec --json` @0.157.1 | LIVE QUALIFIED (ChatGPT OAuth) |
| DEVIN | Devin REST API v3 | INTEGRATION COMPLETE — live blocked: `PAIR_DEVIN_API_KEY` absent (fail-closed, `DEVIN_CREDENTIAL_NOT_RESOLVABLE`, non-routable) |

## Provider/model status

Groq provider DISCOVERED→ACCESS_VALIDATED→QUALIFIED→MODEL_DISCOVERY_ELIGIBLE via real
`api.groq.com/openai/v1/models`; `openai/gpt-oss-20b` QUALIFIED via real completion probe.
Codex observed-model evidence (session_meta + models_cache, no faked enumeration).
DeepSeek provider credential absent by design (DSH runs through its provider route config).

## Live qualification

25/25 live tests pass: P5.1 12/12, P6 9/9, P7 1/1, P8 1/1, P9 2/2 — including the real
T1 PAIR_NATIVE → T2 CODEX → T3 DSH mission over the runtime loop with mid-run restart
survival (~83s).

## Security model

Fail-closed everywhere: unauthorized workspace/path/tool/permission → FAIL_CLOSED_*;
unqualified executor/provider/model → non-routable; credential VALUES never enter evidence
(env var NAMES only); child env = minimal pinned overlay; MC POST mutations require operator
identity (403 `FAIL_CLOSED_OPERATOR_ID_REQUIRED`).

## Recovery model

RecoveryController decision matrix (`pair.os.vnext.recovery-matrix.v1`): bounded budgets
(3/task, 10/mission, 2 replans, 2 remediations, 3 consecutive-identical), exponential
backoff 1s→30s, POLICY_DENIAL→ABORT only, AMBIGUOUS_DISPATCH→RECONCILIATION only,
ARTIFACT_VALIDATION_FAILURE never marks success, checkpointed restart recovery.

## Learning model (P7)

Extractors → deterministic verifier (11 ordered checks + subject-quality gates + MIN_SUPPORT)
→ MODEL_GENERATED auto-quarantine → advisor-only consumption (bounded ±40 score clamp,
plan-template skeletons stripped of executor/permissions and revalidated).

## Self-improvement boundary (P8)

Isolated git worktree pinned to parent commit — never touches the canonical repo.
Classifier gates auto-validate to SAFE_INTERNAL/BEHAVIORAL only. Promotion exclusively via
OPERATOR_AUTHORIZED_PROMOTION; no auto-merge; rollback preserves evidence.

## Mission Control

Read models via canonical services only; operator actions scope-bound and audited;
functional UI over node:http; restart-safe.

## Known limitations (documented, non-blocking, fail-closed)

- Devin credential absent → DEVIN executor DEGRADED/non-routable by design until key exists.
- Upstream `js-tiktoken` quadratic encode was root-caused and minimally fixed (8 KB cap +
  heuristic estimate); upstream repo itself untouched.
- Provider coverage = Groq + Codex-observed only (other providers fail-closed non-routable).
- Mission Control UI is functional, not polished.
- No browser/Windows executors, no account/pool scheduling, no autonomous production
  promotion, no one-person-company layer — V1 scope boundary.

## Known waivers

None. The context-hardening hang was CLOSED WITH A REAL FIX, not waived.

## Test counts

Deterministic: 66 files / 1645 tests / 0 failures (incl. P10 suite 31/31 ×3 stable runs).
Live: 25/25 (above). Clean-room frozen-install build+typecheck: PASS.
Soak (§14), concurrency (§15), crash matrix A–J (§16), integrity/tamper (§17), security (§18),
secret-leak (§19), selfmod (§20), adaptive (§21), MC API (§23), perf (§24): all PASS in suite.

## Clean-room result

Frozen `pnpm install --frozen-lockfile` + typecheck + build in `/tmp/p10-cleanroom` — PASS.
Package reproducibility: see P10 final report §AF (extract → install → typecheck → build →
smoke mission in clean env).

## Release SHA / artifact SHA-256

`release_commit` and `package_sha256` (member-content digest) — see `RELEASE.json`.
The byte-level zip SHA-256 is recorded in the release tag annotation and the P10 report §AE.
