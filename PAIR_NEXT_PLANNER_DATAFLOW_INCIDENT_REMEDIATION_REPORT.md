# PAIR NEXT — POST-P14 INCIDENT REMEDIATION R1 REPORT
## PLANNER DATA-FLOW SOUNDNESS + DETERMINISTIC MISSING-INPUT RECOVERY CLOSURE

- **Audited base HEAD**: `7a0edd1f78b47d438899bec70985c53531d7d964` (main = merged PR #26 Phase D R7)
- **Branch**: `devin/1790912878-planner-dataflow-incident` (one PR, never self-merged)
- **Remediation HEAD**: see git log below
- **Final classification**: `PAIR_NEXT_PLANNER_DATAFLOW_INCIDENT_REMEDIATION_PENDING_INDEPENDENT_AUDIT`

---

## 1. Incident reproduction (live evidence, mission `MSN_01M3XA44P4P2PEMEJZT8KNTJH3`)

Plan table of the failed mission (db `~/pair-mc-live/pair.db`):

```
T1  record goal          AUTOMATON_TASK_EXECUTION  deps=[]       COMPLETED
T2  research mql5        REMOTE_CLOUD_TASK_EXECUTION deps=["T1"] RUNNING (on DEVIN)
T3  deliver to telegram  TELEGRAM_DELIVERY         deps=[]       FAILED ×5
```

- T3 was dispatched at t=0 (`pickRunnable`: all declared deps completed — vacuously true for `deps=[]`).
- T3's job required `outbox/EA_Sales_Strategy.txt`, produced by T2 — a data-flow edge the DAG never declared.
- CODEX executor journal `~/pair-mc-live/journal/codex/EXE_*/stdout.jsonl` shows the agent correctly reporting the file missing → `CODEX_AGENT_REPORTED_FAILURE`.
- `classifyFailure` mapped it to retryable **PROCESS_EXIT** → RETRY_SAME_ROUTE burn loop: attempts 1–4 identical, one governed budget extension approved via APRE (Phase D exercised correctly), attempt 5 identical → budget exhausted → mission FAILED, while T2 was still RUNNING.
- Counter-example `MSN_01M3W4FW5RDZQCAMRBNZZBH3Z8` (same shape, day before): its delivery task carried `deps:["T2"]` — no error. The defect is nondeterministic LLM `depends_on` output, NOT a PR #26 regression.

## 2. Root cause

1. **Planner DAG structurally valid but data-flow unsound**: `depends_on` edges were the only ordering authority and the LLM was trusted to declare every producer edge. A consumer needing an artifact could omit its producer and nothing noticed — DAG validation checks *declared* structure, never *artifact* flow.
2. **Deterministic missing prerequisite classified as retryable**: `CODEX_AGENT_REPORTED_FAILURE` matched no CLASS_RULE → fell to PROCESS_EXIT (`retry_allowed: true`) → identical executions burned the budget. Classification had no canonical way to distinguish "input will never exist" from "transient executor failure".

## 3. Remediation — one canonical data-flow authority

New module `src/pair/plan-dataflow.ts` exports:

- `reconcilePlanDataflow(tasks)` — mutating repair at the canonical seam: persists `metadata.pair_dataflow` on every task + injects missing producer edges with durable repair evidence (`metadata.pair_dataflow_repairs`).
- `assertPlanDataflow(tasks)` — pure re-validation at every commit/consume boundary: preview pin, confirm replay, `runPlanning`, `runReplan`. Never mutates.
- `extractTaskDataflow(task)` — the deterministic artifact I/O model.
- `provenMissingConsumedArtifact({task, workspace})` — evidence-only recovery seam.
- `normalizeArtifactPath(raw)` — canonical workspace-relative path normalization.

### Artifact model `metadata.pair_dataflow = {produces, consumes}`

Derived ONLY from authoritative/explicit task material — bounded grammar, no open-ended NLP:

| Source | Rule |
|---|---|
| `metadata.expected_output_contract.worker_spec.ops` | `write_text_file`/`append_text_file` → produces; `read_text_file`/`delete_file` → consumes (structured, authoritative) |
| Canonical task instruction | path tokens attributed by bounded verb grammar: destination marker immediately before the token (`to`/`into`/`onto`/`in`) → produce; consume verbs (`read|load|consume|copy|use|from|contains|…`) → consume; produce verbs (`write|create|save|generate|output|emit|store|upload|…`) → produce; `outbox/<file>` → produce (outbox contract); unattributed mentions → ignored |
| `metadata.pair_dataflow` declared | normalized + validated; unsafe entries → `FAIL_CLOSED_PLAN_DATAFLOW_PATH` |

Normalization rejects: absolute paths (`/`, `~`, `C:\`), `..` segments, backslashes, bare directory refs, >240 chars, extensionless basenames. Bounded: ≤32 artifacts/task (`FAIL_CLOSED_PLAN_DATAFLOW_BOUNDS`). Remote-capability tasks (`REMOTE_CLOUD_TASK_EXECUTION`, `AUTONOMOUS_CODE_EXECUTION`) produce/consume NO local artifacts — their files stay remote; only result text flows via `dependency_outputs` edges.

### Reconcile rules (mandate §4)

- **CASE A** one earlier producer: declared edge → PASS; missing → inject edge (dedupe, order by plan index) + append repair record `{consumer_key, producer_key, artifact, reason:"ARTIFACT_DATAFLOW", original_depends_on, resulting_depends_on}` pinned on the consumer task — digested, previewed, confirmed, committed verbatim. Zero mutation after `planDigest`.
- **CASE B** producer only later / repair would create a cycle → `FAIL_CLOSED_PLAN_DATAFLOW_ORDER` → candidate becomes PLAN_INVALID at the failover canonicalize seam (bounded failover picks another candidate).
- **CASE C** >1 earlier producer → `FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_PRODUCER`.
- **CASE D** zero producers anywhere → `FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT`. No filesystem guesses; no pre-existing-input authority exists yet — declared consume on unproduced input is unsatisfiable by definition.
- **CASE E** fan-out preserved: only consumed artifacts force edges — independent producers stay parallel (never serialized as a shortcut).
- **Delivery contract**: `TELEGRAM_DELIVERY` is the terminal report step — it consumes every upstream result text via `dependency_outputs`, so it must depend on ALL other tasks (edges tagged `RESULT_TEXT` in evidence; real artifact names win when a task is both artifact-producer and result source).

### Wiring (mandate §5, §6)

`sanitizePlan → contract enrichment → reconcilePlanDataflow → validatePlanProposal → winner → planDigest → preview` — reconcile runs inside `canonicalizeLlmTasks` in `scripts/serve-mission-control.mjs`, covering BOTH the failover `canonicalize` callback (a reconcile throw → PLAN_INVALID → next candidate) and the `metadata.llm_plan` replay path. The failover winner is already data-flow sound; the preview pins the repaired list exactly.

`assertPlanDataflow` is replayed (validate-only) at: `createPlanPreview` (pre-digest), `confirmPlanPreview` (persisted canonical_tasks — a pre-R1 READY preview with an unsound DAG fails closed, is NOT consumed, no mission is minted, digest untouched — test H), `runPlanning`, `runReplan`. Pinned-plan invariant preserved: previewed ≡ confirmed ≡ committed ≡ executed.

### Evidence design (mandate §7)

`metadata.pair_dataflow` inside the pinned canonical tasks — no new entity kind, covered by plan_digest, restart-safe, bounded. Repair ledger `metadata.pair_dataflow_repairs` only on repaired consumers; deterministic fields, no raw LLM prose. Reconcile is idempotent: re-running a repaired list produces byte-identical output (test G), so the digest is stable across the canonicalize replays.

## 4. Recovery classification (mandate §8, §9)

`MissionRuntime.classifyWithDependencyEvidence` — inserted between `classifyFailure` and `startRecovery` in `settleExecution` AND the dispatch-arm catch:

```
base = classifyFailure(...)
if (!RECOVERY_MATRIX[base].retry_allowed) → keep base      // never widen bounded classes
task.metadata.pair_dataflow.consumes empty/absent → keep base  // no canonical evidence, no fabrication
for each consumed artifact (skip self-produced):
    absent in workspace → DEPENDENCY_FAILURE                 // proven missing prerequisite
```

- Evidence = persisted digested `pair_dataflow` ONLY — never executor summary/stderr prose, never a filesystem guess about *intent*. Artifact absence is checked at the task's canonical workspace (`tmd.workspace ?? authorized_workspaces[0]`).
- `DEPENDENCY_FAILURE` (already in the matrix: `[REPLAN, ABORT]`, `retry_allowed:false`) → bounded replan/abort, zero identical retry burns, zero approval consumption.
- `pickRunnable` unchanged: runnable = all DECLARED deps COMPLETED. Repair happens before commitment, so the committed DAG is always sufficient — no second scheduler, no executor self-report modifying scheduling.
- Legacy tasks (pre-R1) carry no `pair_dataflow` → evidence absent → base class stands. No behavior change for old rows.

## 5. Planner prompt (mandate §11 — defense-in-depth only)

`SYSTEM_PROMPT` `depends_on` rule now requires declaring every task whose output is needed (file read/copied/delivered OR returned result text), while independent work stays parallel. Prompt guidance is a hint — the deterministic reconcile remains the sole authority for correctness.

## 6. Test evidence

### Focused suite `src/__tests__/pair-planner-dataflow-incident.test.ts` — 13/13 PASS

- **A** incident shape (delivery `deps:[]` consuming `analysis.txt`): edge T3→T2 injected with `artifact:"analysis.txt"`, T3→T1 `RESULT_TEXT`; repairs ledger pinned; `assertPlanDataflow` passes post-repair.
- **remote**: remote task → `{produces:[],consumes:[]}`; local consumer of remote-only artifact → `UNBOUND_INPUT`.
- **B** declared edge → no dup, no repair row.
- **C** fan-out B∥C→D — both edges, producers stay `deps:[]` (parallel).
- **D** unbound input → `FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT`; **E** ambiguous → `FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_PRODUCER`; **F** backward producer + declared cycle → `FAIL_CLOSED_PLAN_DATAFLOW_ORDER`.
- **G** deterministic + idempotent: identical output + identical planDigest; second reconcile = zero repairs.
- **path safety**: absolute/`..`/drive-letter/dir/tilde → null; unsafe declared consume → `FAIL_CLOSED_PLAN_DATAFLOW_PATH`.
- **H** legacy READY preview (digests computed over the UNSOUND list): `confirmPlanPreview` → `FAIL_CLOSED_PLAN_DATAFLOW_UNSOUND`; preview stays READY, digest untouched, not consumed, zero missions.
- **Recovery C+D**: producer "completes" but never lands the artifact → consumer fails → decision `failure_class=DEPENDENCY_FAILURE`; consumer ran exactly ONE execution; every decision action ∈ {REPLAN, ABORT}; zero approval_request.
- **Recovery A+B**: task with no consumes fails with `PROCESS_EXIT` → first decision action ∈ {RETRY_SAME_ROUTE, RE_ROUTE}; class NOT fabricated into DEPENDENCY_FAILURE.
- **E2E**: preview → confirm → drive to `COMPLETED`; T3 dispatched strictly after T2 (writes `analysis.txt`); every task exactly one execution; zero recovery_decisions, zero approvals.

### Regression (mandate §15)

| Suite | Result |
|---|---|
| Phase B (`pair-phase-b`) | 123/123 PASS |
| PR#23 (`pair-live-ops-recovery-closure`) | 20/20 PASS |
| PR#24 (`pair-route-capability-authority`) | 36/36 PASS |
| Phase C (`pair-phase-c-dsh-model-routing`) | 51/51 PASS |
| Phase D (`pair-phase-d-recovery-approval-hardening`) | 37/37 PASS |
| Focused R1 | 13/13 PASS |
| **Full suite** | **2576 pass / 2 fail / 15 skipped** — the 2 failures are the known env-dependent P5 probes (DSH/CODEX binaries in PATH → `probe().available===true`), identical to base `7a0edd1` (2563 pass there = 2576 − 13 new tests). No new failure vs base. |
| `npx tsc --noEmit` | clean |
| `pnpm build` | clean |

### Review invariants (mandate §16–17)

No new broad catch (none added anywhere); no summary/stderr regex as authority; no filesystem-existence as planner authority (filesystem consulted ONLY at recovery classification, and only against canonical declared consumes); single DAG authority (`pickRunnable` unchanged); zero post-digest mutation; legacy preview never repaired — rejected; no forced serialization (fan-out test C); no dup dep injection (test B); deterministic order-independent output (test G); bounded artifact scanning (32/task, instruction ≤4096 chars); no absolute/traversal paths; no raw LLM output in durable evidence; no new retry loops (DEPENDENCY_FAILURE = non-retry); no Phase D behavior changes.

## 7. Limitations / remaining debt

- **Pre-existing workspace files**: an operator goal like "check existing report.txt" has no canonical way to declare a pre-existing input — a task consuming it fails closed as UNBOUND_INPUT (mandated: no filesystem guesses). A future canonical `preexisting_inputs` authority could open this deliberately.
- **Instruction grammar is a hint layer**: only verb-attributed path mentions count; unattributed mentions are ignored (never guessed). The structured contract (`worker_spec.ops`, declared `pair_dataflow`) is authoritative.
- **Delivery rule is conservative**: `TELEGRAM_DELIVERY` depends on ALL other tasks — correct for a final report step; a multi-delivery plan would serialize deliveries behind each other (acceptable: delivery is defined terminal).
- Recovery override applies only when the base class is retryable — a proven missing input under an already-bounded class keeps the (already safe) bound.

## 8. Changed files

See `git diff --stat` on the PR. Live deployment note: prod `/home/ubuntu/pair-prod-main` still runs `7a0edd1` until the operator merges and restarts; this PR does NOT restart or touch prod.

---

# R2 — Explicit Telegram Delivery Authority + Data-Flow Audit Closure (revised mandate)

## 1. Semantics enforced (R2 §0)

Telegram has two distinct roles and R2 makes them disjoint:

- **(A) Notification channel** — mission lifecycle status updates to the operator. Carries NO files. Bridge notify block unchanged.
- **(B) Explicit delivery channel** — sends ONLY what an effective operator request explicitly asked to be sent, through a governed `TELEGRAM_DELIVERY` operation with a canonical manifest.

`FILE PRESENCE != TELEGRAM SEND AUTHORITY. OUTBOX PRESENCE != TELEGRAM SEND AUTHORITY. MISSION COMPLETION != FILE DELIVERY AUTHORITY.` An execution producing an artifact is storage/provenance only.

## 2. Intent contract (§2) — `src/pair/plan-dataflow.ts`

- `detectTelegramDeliveryIntent(goal)` — `requested = TELEGRAM_MENTION(/\btelegram\b|\btele\b/i) AND DELIVERY_VERB(send|deliver|forward|share|post|upload|gửi|đẩy|đưa|chuyển|báo|bắn|đăng|đính)`; `artifacts` = normalized `PATH_TOKEN` mentions (≤16); `mode = FILES` iff artifacts non-empty else `TEXT`. Conservative: unknown → not requested.
- Authority is **pinned by PAIR at canonicalization** — `reconcilePlanDataflow(tasks, {telegramIntent})` stamps `metadata.pair_telegram_delivery = {requested:true, mode, artifacts[]}` on delivery tasks ONLY when `intent.requested`; otherwise a `TELEGRAM_DELIVERY` task fails closed (`FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT`). **Planner cannot mint intent** — stamped manifest is digest-covered (stamped pre-digest at preview/confirm/plan/replan, same as pair_dataflow).

## 3. Manifest (§3)

Workspace-relative names, `normalizeArtifactPath`-normalized, bounded ≤16, no traversal/absolute. FILES names get an implicit `outbox/<basename>` consume resolution candidate. TEXT mode = bounded text from task results (≤3500 chars). Manifest is stored in `metadata.pair_telegram_delivery` (field `pair_telegram_delivery`) — persisted in canonical plan, digest-covered, not expandable by executor/fs.

## 4. Delivery DAG rules (§4 + §5)

In `requiredEdges`, for a delivery task with stamped manifest:

- **FILES**: each manifest artifact binds to the unique EARLIER producer of `{name}` or `outbox/{basename}` (later-only → `FAIL_CLOSED_PLAN_DATAFLOW_ORDER`; ambiguous → AMBIGUOUS_PRODUCER; none → remote fallback below).
- **Remote fallback**: manifest artifact with no local producer edges to ALL earlier remote tasks via synthetic artifact `PAIR_OUTBOX_UPLOAD:{artifact}`; a LATER remote producer → `FAIL_CLOSED_PLAN_DATAFLOW_ORDER`; no earlier remote → `UNBOUND_INPUT`.
- **TEXT**: RESULT_TEXT edges to every earlier content-bearing task (`isContentBearing` excludes `AUTOMATON_TASK_EXECUTION`); no invented artifact dep.
- **Leaf-only**: `assertDeliveryLeaves` — any task declaring `depends_on` a delivery task → `FAIL_CLOSED_PLAN_DATAFLOW_ORDER` (in BOTH reconcile and assert). Delivery task without stamped manifest → `FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT`.
- Manifest consumes live in `needed` always (a task's own grammar produce never self-satisfies its manifest).

## 5. Bridge transport (§1 + §6) — `scripts/telegram-bridge.mjs`, `src/pair/telegram-delivery.ts`

- **Generic outbox scan→send→.sent block REMOVED.** Outbox is storage only.
- Bridge polls `GET /api/telegram-deliveries?state=QUEUED`; TEXT → send `req.text` + ack; FILES per artifact → `.sent` witness protocol: witness exists → ack without resend (crash-safe at-most-once); else rename-before-send → ack; send failure → rename back, stays QUEUED. Status notifications above it untouched.
- **Durable entity** `telegram_delivery_request` (`TDR_<digest24>` deterministic per mission+task): minted in `settleExecution` COMPLETED+PASS for `TELEGRAM_DELIVERY`-cap tasks (idempotent tryGet). `pendingTelegramDeliveries` projects QUEUED + resolved abs paths (exact `outbox/rel` → unique `*-{rel}` remote-upload prefix → workspace path). `ackTelegramDelivery` idempotent per-artifact flip → request SENT when all acked; unknown artifact → `FAIL_CLOSED_TELEGRAM_DELIVERY_ARTIFACT`.
- Endpoints: `GET /api/telegram-deliveries?state=` + `POST /api/telegram-deliveries/:id/ack` (`{artifact}`), MC_TOKEN-gated.

## 6. §7–§12 closure

- **§7**: `POST /api/outbox` lands `{outboxDir}/{taskPrefix}-{filename}` — storage only; resolution treats `*-{name}` uploads as candidates, never send authority.
- **§8**: mission status notifications independent/working (bridge notify block untouched; test A+B+C proves COMPLETED + zero sends).
- **§9**: `prerequisiteMissing(mission, task)` in the RUNNING dispatch loop BEFORE `routeGovernedTask` — canonical `pair_dataflow.consumes` resolved via `missingConsumedArtifact` (workspace direct + outbox exact + unique `*-{name}` remote-upload suffix) → `DEPENDENCY_FAILURE` via `startRecovery`, zero dispatches, no retry burn, no approval extension.
- **§10**: `classifyWithDependencyEvidence` REMOVED — post-failure absence never reclassifies (file deleted mid-task → PROCESS_EXIT stays; test K).
- **§11**: `RESERVED_TASK_METADATA_KEYS` (pair_dataflow, pair_dataflow_repairs, pair_telegram_delivery, telegram_delivery, telegram_delivery_requested, telegram_intent) stripped in `reconcilePlanDataflow` before extraction; PAIR restamps. `PAIR_DATAFLOW_ORIGINAL_DEPS` stamped once + preserved → byte-identical replay (test L).
- **§12**: `nearestVerbRole(before)` — LAST consume/produce verb in bounded 120-char window; DESTINATION tail (to/into/onto/in) wins for destination paths; contract ops stay authoritative (test M).

## 7. Tests (§13–16) — `pair-planner-dataflow-incident.test.ts` (25 total, +12)

| Case | Evidence |
|---|---|
| A+B+C default | mission produces `outbox/report.txt` + stray `outbox/stray.png`, goal has NO telegram intent → COMPLETED, **0 delivery_request rows, 0 sends**; planner-minted delivery w/o intent → `FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT`, no mission |
| D explicit FILES | goal "send it to telegram" + manifest [report.txt] → COMPLETED → **exactly ["report.txt"] sent once**, TDR `TDR_<digest>` SENT w/ `sent_at`, second poll `[]` |
| E subset | manifest [a.txt,c.png] of producer's {a,b,c} → sent `["a.txt","c.png"]`, b.txt never |
| F ordering | producer SLOW (RUNNING) → T3 undispatched, 0 requests, `bridgeSend=[]`; converge → sent once, second poll `[]` |
| G+H remote | manifest `chart.png` w/ remote producer → `PAIR_OUTBOX_UPLOAD` dep [T2]; upload lands WHILE RUNNING → 0 sends; COMPLETED → resolves `TSK_x-chart.png` → `["chart.png"]` once |
| I TEXT | deps [T1,T2] via RESULT_TEXT, zero artifact consumes; send `[TEXT:TDR_*]` once |
| K post-dispatch | input deleted mid-exec → first decision NOT DEPENDENCY_FAILURE (PROCESS_EXIT); retry → PRE-dispatch DEPENDENCY_FAILURE, exec count stays 1 |
| L forged | forged manifest/intent/pair_dataflow/repairs stripped + recomputed; forged manifest can't mint authority (INTENT throw) |
| M grammar | `read input.txt then generate report.txt` → consume input/produce report; `copy a.txt into outbox/b.txt` → consume a/produce b |
| N leaf | delivery-before-producer → ORDER; declared edge INTO delivery → ORDER; unproduced non-remote manifest → UNBOUND |
| intent | mention+verb required both; vn verbs; no-verb→not requested; no-file→TEXT |

## 8. Regression (§17)

| Suite | Result |
|---|---|
| Focused incident (R1+R2) | 25/25 PASS |
| pair-ops-telegram-delivery | 3/3 PASS |
| Phase B | 123/123 PASS |
| PR#23 live-ops-recovery | 20/20 PASS |
| PR#24 route-capability | 36/36 PASS |
| Phase C DSH routing | 51/51 PASS |
| Phase D recovery-approval | 37/37 PASS |
| heartbeat-scheduler | 20/20 PASS |
| pair-llm-planner | 16/16 PASS |
| plan-execute-flow | 14/14 PASS (in full suite) |
| **Full suite** | **2588 pass / 2 fail / 15 skipped** — same 2 env P5 probes (DSH/CODEX binaries present in PATH). Base `7a0edd1` = 2563, R1 = 2576; +12 R2 tests, zero regression |
| `npx tsc --noEmit` | clean |
| `pnpm build` | clean |

## 9. §19 — 8 explicit proofs

1. Ordinary mission + outbox files, no intent → **zero sends** (test A+B+C: COMPLETED, 0 TDR rows)
2. COMPLETED + no intent → **zero deliveries** (same)
3. Explicit intent → **manifested send once** (test D: `["report.txt"]` + SENT durable)
4. Unrelated file → **not sent** (test E: b.txt absent; stray.png never)
5. DEVIN upload pre-completion → **not sent** (test G+H: upload while RUNNING → `[]`)
6. DEVIN completes → **once** (`["chart.png"]`, second poll `[]`)
7. Missing prereq → **0 dispatches** + DEPENDENCY_FAILURE (tests C+D R1 & K: exec count stays 1/0)
8. No forward-dep repair → delivery-before-producer → `FAIL_CLOSED_PLAN_DATAFLOW_ORDER` (test N)

Final classification: `PAIR_NEXT_PLANNER_DATAFLOW_INCIDENT_REMEDIATION_R2_PENDING_INDEPENDENT_AUDIT`

STOP. DO NOT MERGE. DO NOT START PHASE E.
