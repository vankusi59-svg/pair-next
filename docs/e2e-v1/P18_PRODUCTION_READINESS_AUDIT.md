# P16–P18 Production Readiness Audit — V1

## Gate matrix

| Gate | Verdict | Evidence |
|---|---|---|
| A — Runtime | **PASS** | boot log (CODEX+PAIR_NATIVE QUALIFIED, DSH/DEVIN unqualified), codex bounded invocation 7,083 tokens |
| B — Full autonomous execution | **PASS** | `OBJ_1050b1f751ab60ba540c4593` ACTIVE→ACHIEVED: policy → claim → CEO(codex `gpt-5.6-sol` ACCEPTED) → planner → mission COMPLETED → artifact ACCEPTED (CAS sha `979ff1e8…`, bytes `HELLO_FROM_AUTONOMOUS_COMPANY`) → owner KPI → TARGET_MET_CANDIDATE → owner sign-off `RSO_01M5R1NBAFN2SFS260T8J1S9BZ` |
| C — Strategic Brain | **PASS** | brief composed into `observation_digest`; replay dedup (same decision id, no new attempt); grant authority fail-closed |
| D — Scoped Learning | **PASS** | scoped reads: A-only/A∁ verified on persisted rows; 4 system-extracted scoped experiences; honest exclusion counts |
| E — Company Coordination | **PASS** | E1 `UPSTREAM_UNMET`, E2 SUPERSEDES recovery, E3 `pair_dataflow_sources` pin, E4 suspend/revoke→`[]`, E5 `CONFLICT_LEASE_HELD`, E6 exact-set covers, E7 portfolio honest |
| F — UI E2E | **PASS** | 23/25 live assertions, real Chromium on live stack; evidence `docs/e2e-v1/ui-*.png`, `ui-live-results.json` |
| G — Recovery & Safety | **PASS** | restart mid-pending (integrity `ok`), terminal-write reject, signoff replay reject, policy disable, corrupt-row typed wedge, capability-gap projection |

## Independent audit — VERDICT: SHIP (evidence authentic)

Sub-agent `b1ff8a87` (codex-reviewer, non-implementer) audited the repair diff and the live db at hash level:

- **Repair**: 3 independent provider-pin gates; `FAIL_CLOSED_CEO_MODEL_CONFIG` before any catalog read; no qualification/seeding bypass; argv-array spawn blocks flag injection; only model-selection path verified; 16/16 tests.
- **Authenticity**: 607/607 entity `payload_hash` verified; 1,119/1,119 `event_hash` verified; gapless monotonic `seq`; byte-exact CAS (`HELLO_FROM_AUTONOMOUS_COMPANY` sha-matched); real codex `stdout.jsonl` journals (pids, token counts, turn.completed); STARTED→COMMITTED→SETTLED triples with real 5–8s latencies; honest failure tails (stale observation `CCA_1be2ea24`, agent-reported task failure, recovery retries) — ruled out staged fabrication.
- **Timing coherence**: unblock ~500ms after SUPERSEDES mint; `DRIVER_PASS_FAULT` at the exact CONFLICTS second; signoff/status ms-identical.
- **Isolation**: zero non-scratch paths; empty credential vault; `gpt-5.6-sol/codex-cli` is the only reasoning transport anywhere in 1,119 events; DEVIN/DSH executors UNQUALIFIED.
- **Auditor findings applied**: (a) "agnes unqualified" wording corrected — provider/model qualify on liveness probes only, the DSH *execution path* stayed UNQUALIFIED with zero invocations; (b) event seq 1119 (`OBJECTIVE_RELATION_CREATED` with deleted row) documented as the Gate-G corruption-probe artifact.
- **No HIGH/CRITICAL issues.** Minor notes: ambient `PAIR_CEO_MODEL` could affect pre-existing default-resolution test expectations (same exposure class as every `PAIR_*` seam); HTTP-layer negative claims are corroborated by live probes + `ui-live-results.json` (which discloses its own 2 failed assertions), not by db rows alone.

## Production-readiness classification

**Pending independent-audit verdict.** Gate evidence supports `P18_CONDITIONAL_PASS_WITH_GAPS` at minimum; `P18_PRODUCTION_READINESS_PASS` requires auditor VERIFIED with no unresolved HIGH/CRITICAL.

## Method notes / limitations (honest)

- Live E2E exercised one objective to ACHIEVED and a second to completed mission; CEO calls were real (`gpt-5.6-sol`, 8 attempts recorded). Codex subscription rate limits bound further repetition.
- UI assertions are content-presence checks on real rendered pages, not pixel-level; two initial assertions failed on wrong routes and were corrected — all final assertions documented in `ui-live*.mjs`.
- Relations/duties minted via canonical sidecar services on the same WAL db (no public HTTP mint route exists by design) — recorded as product gap, not bypass: the *verdicts* were all observed through the running HTTP server.
- G3/G4 (executor failure, reasoner unavailable) are evidenced by capability-gap projection + prior `SUBSCRIPTION_AUTH_UNVERIFIED` run + unit suites rather than a dedicated forced-fault drill this run.
- Scratch env only; nothing in this run constitutes production deployment readiness for real business data.
