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

---

# R3 — independent-audit closure (delivery scope + destination + transport)

Audited R2 HEAD `d476f43888d6158cb64d4bb84e59f184ec148751` → R3 commit on the
same PR #27. All R1/R2 + Phase A/B/C/D invariants preserved.

## §0 Semantics closed

- **Manifest over-capture root cause**: R2's `detectTelegramDeliveryIntent`
  attributed file arguments from the WHOLE goal — `read private.csv,
  create report.txt and send report.txt to Telegram` captured all three
  names, authorizing a private input file for transmission. R3 rewrote the
  intent contract as bounded CLAUSE grammar: a delivery clause = delivery
  verb + Telegram mention within 160 chars (either direction); artifacts
  are ONLY path tokens parsed from inside that clause by the
  `CLAUSE_FILLER`/`CLAUSE_PATH` list grammar (path tokens checked before
  filler articles so `a.txt` can't be eaten by "a"). Files outside the
  clause — including consumed inputs like private.csv — never manifest.
  Ambiguous scope → TEXT mode; unknown phrasing → not requested.
- **Negation authority**: Unicode-boundary-correct `NEGATION_RE` (JS `\b`
  does not treat `đ`/`à` as word chars — "đừng"/"và" silently failed
  before; fixed with `(?<![\p{L}\p{N}\p{M}_])…(?!…)` + NFC normalize).
  Any of `do not send / don't send / do not upload / đừng gửi / không cần
  gửi` governing the clause → `requested=false, artifacts=[]` — fail-safe
  is NO SEND.
- **Recipient binding**: `mission_origin = {operator_id, MISSION_INGRESS}`
  pinned at mission ingress (never caller metadata) → telegram:X origin
  binds destination `chat_id=X` (`MISSION_ORIGIN` provenance); else
  exactly-one `PAIR_TG_DELIVERY_CHAT_ID` (`CONFIGURED_DEFAULT`); else the
  request mints `UNSENDABLE` + `hold_reason` (fail closed, durable). The
  planner never mints a destination; the allowlist stays an authorization
  check, never a broadcast list — a bound destination not in the
  allowlist → UNSENDABLE hold, zero sends.
- **Allowlist vs destination**: allowlist is checked INSIDE the transport
  against the bound destination only — never iterated as recipients.
- **Transport state machine**: per-artifact `QUEUED → SENDING → SENT |
  QUEUED(+last_error) | UNKNOWN_SIDE_EFFECT` (request-level for TEXT).
  `beginDeliveryAttempt` persists SENDING BEFORE the network call; SENT
  requires definite success + `message_id` evidence + `completed_at`;
  definite failure → back to QUEUED with bounded `last_error`; ambiguous
  → UNKNOWN_SIDE_EFFECT — never auto-resend, never SENT.
- **Success evidence**: `message_id` + `sent_at`/`completed_at` on the
  artifact — filename marks are gone.
- **Failure semantics**: `send()`/`sendFile()`/`tg()` now classify
  definite (Telegram API said no) vs unknown (network/parse died inside
  the call). `governedSend` propagates both — failures are NEVER
  swallowed and NEVER acked.
- **UNKNOWN_SIDE_EFFECT**: stale SENDING (process died inside the
  transport window) reconciles to UNKNOWN_SIDE_EFFECT with
  `stale_sending_reconciled:<ts>` evidence on the next
  `pendingTelegramDeliveries` pass — explicit ambiguous path, no blind
  resend, no false SENT.
- **.sent removal**: the rename-before-send witness is deleted entirely —
  no filename is transport state anymore (§6+§8 verified: zero `*.sent`
  files created anywhere).
- **Crash-window tests**: §15 A–D — crash-before-send → reconcile
  UNKNOWN (0 sends); crash-after-accept-before-ack → UNKNOWN (1 send
  ever, no dup); crash-after-SENT → 0 duplicate sends; ack/db failure →
  durable SENDING → reconcilable UNKNOWN.
- **Real transport tests**: `src/pair/telegram-transport.ts` extracts the
  exact transport the bridge runs (`transportTelegramDelivery` with
  injectable `GovernedTelegramTransport` + `DeliveryBackend`); tests call
  the same function — no reimplemented test harness.
- **Regression**: full R2/R1 non-regression — zero default sends,
  explicit-only, pre-dispatch missing, no post-failure reclassify, no
  forged metadata, leaf/order rules, remote DEVIN, notifications all PASS.

## Changed files

`src/pair/plan-dataflow.ts` (R3 clause grammar + Unicode boundaries),
`src/pair/telegram-delivery.ts` (destination + UNSENDABLE + SENDING/SENT/
UNKNOWN lifecycle + stale reconcile), `src/pair/telegram-transport.ts`
(NEW — governed transport), `src/pair/mission-control.ts` (mission_origin
pin + `transitionTelegramDelivery`), `src/pair/mission-control-server.ts`
(`POST /api/telegram-deliveries/:id/transition`), `src/pair/
mission-runtime.ts` (`telegramDeliveryDefaultChatId` dep + mint wiring),
`src/pair/index.ts` (export), `scripts/serve-mission-control.mjs`
(`PAIR_TG_DELIVERY_CHAT_ID` env), `scripts/telegram-bridge.mjs` (governed
send + transition backend, `.sent` removed), test file (+23 tests → 48),
this report.

## Test counts

| Suite | Result |
|---|---|
| Focused incident (R1+R2+R3) | **48/48 PASS** (13 R1 + 12 R2 + 23 R3) |
| pair-ops-telegram-delivery | 3/3 PASS |
| Phase B / PR#23 / PR#24 / Phase C / Phase D | 123+20+36+51+37 PASS |
| **Full suite** | **2611 pass / 2 fail env P5 cũ / 15 skipped** (R2 2588 → +23, zero regression) |
| `npx tsc --noEmit` / `pnpm build` | clean / clean |

## §19 — 8 proofs

1. `read private.csv, create report.txt and send report.txt to Telegram` →
   manifest = `["report.txt"]` only (§11 A).
2. `đừng gửi report.txt lên Telegram` → `requested=false`, zero send
   authority (§12 — all 5 negations).
3. Allowlist `{12345,67890}` + origin `telegram:12345` → every call goes
   to `12345` only; `67890` never receives (§13 A).
4. Definite failure → artifact back to QUEUED + `last_error`, status NOT
   SENT, zero false ACK, retryable on next poll (§14 A/B/C).
5. Crash before send after durable SENDING → reconcile
   `UNKNOWN_SIDE_EFFECT`, zero sends, never claimed SENT (§15 A).
6. Definite success → `message_id` + `completed_at` + request `SENT`
   persisted (§14 D).
7. Restart after SENT → zero duplicate sends (§15 C — exactly 1 network
   call ever).
8. All R2 invariants PASS — zero default sends, explicit-only intent,
   pre-dispatch missing-input, no post-failure reclassify, forged
   metadata stripped, leaf/order fail-closed, remote DEVIN upload,
   notification separation (full regression + focused R2 suite).

Final classification: `PAIR_NEXT_PLANNER_DATAFLOW_INCIDENT_REMEDIATION_R3_PENDING_INDEPENDENT_AUDIT`

STOP. DO NOT MERGE. DO NOT START PHASE E.

---

# R4 — Transport final state-machine closure (audit `pasted-1790919457093.txt`)

Base: audited R3 HEAD `7c7f9b6` · branch/PR unchanged (incident R4 continues on
the same PR #27) · `DO NOT` scope: no new PR, no merge, no Phase E, no redesign
of R1/R2/R3.

## §1 — TEXT stale-SENDING asymmetry (BLOCKER) → closed

**Bug**: TEXT `attempt_state` was removed on reconcile but the request stayed
`QUEUED` → the next poll re-sent the text Telegram may already have accepted.
**Fix**: TEXT now carries the identical durable slot as FILES
(`text_state` + all attempt fields at request level). Stale TEXT `SENDING`
reconciles to `UNKNOWN_SIDE_EFFECT` with `stale_sending_reconciled:<now>`
evidence — never re-projected, never auto-resend, never false SENT.
Test §9: begin→SENDING→crash→pending → `text_state=UNKNOWN_SIDE_EFFECT`,
zero calls, `pending[]` empty, `status≠SENT`.

## §2 — SENT requires real message_id (BLOCKER) → closed

Two fail-closed layers: (a) `transportTelegramDelivery` classifies
`{kind:"ok"}` **without** a valid `message_id` as `backend.unknown`
(`acceptance_unproven:no message_id`) — applied to TEXT, .txt/.md
sendMessage, and binary sendDocument paths; (b) the server transition
`resolveDeliveryAttempt(SENT)` independently rejects missing/invalid
message_id with `FAIL_CLOSED_TELEGRAM_DELIVERY_EVIDENCE` — the bridge is
never trusted alone. Production `governedSend()` in
`scripts/telegram-bridge.mjs` validates `result.message_id` (missing →
`{kind:"unknown"}`). Test §11: 3 payload kinds → `UNKNOWN_SIDE_EFFECT`,
`message_id` undefined, `status≠SENT`; direct `to=SENT` with
undefined/null/"" → throw ×3; real message_id still lands SENT.

## §3 — bounded retry governance (BLOCKER) → closed

Every payload slot now persists `attempt_count`, `max_attempts`,
`next_retry_at`, `last_error`. Canonical ceiling
`PAIR_TG_DELIVERY_MAX_ATTEMPTS` via `telegramDeliveryMaxAttempts()`
(env-config bounded parse `[1..10]`, default `3`, fail-closed on
malformed) wired serve → `MissionRuntimeDeps.telegramDeliveryMaxAttempts`
→ `mintTelegramDeliveryRequest` (stamped per slot at mint; default
`TELEGRAM_DELIVERY_DEFAULT_MAX_ATTEMPTS=3` fallback). Definite failure:
`attempt_count++`; `< ceiling` → `QUEUED` + `next_retry_at =
now + min(60, 5·attempt_count)s` deterministic backoff; `== ceiling` →
`FAILED_DELIVERY` durable terminal hold. No human approval for retry
budget; no infinite retry. Test §12: attempt1→QUEUED+`next_retry_at=+5s`;
poll inside backoff → **zero sends, not projected**; attempt2→+10s;
attempt3→`FAILED_DELIVERY`; polls at +60s/+600s/+60000s → zero sends
forever.

## §4 — pending projection honors lifecycle → closed

`pendingTelegramDeliveries(store, now)` reconciles stale `SENDING`
(TEXT and FILES) to `UNKNOWN_SIDE_EFFECT` first, then returns ONLY
requests with ≥1 eligible payload: `state===QUEUED` +
`attempt_count<max_attempts` + `next_retry_at<=now`. Excluded entirely:
SENT, UNSENDABLE, FAILED_DELIVERY, UNKNOWN_SIDE_EFFECT, SENDING, and
QUEUED payloads whose `next_retry_at` is still in the future — a request
with zero eligible payloads is not projected at all. No bridge-side
sleep is the authority.

## §5 — legacy /ack bypass removed (BLOCKER) → closed

`POST /api/telegram-deliveries/:id/ack` route DELETED from
`mission-control-server.ts`; `MissionControl.ackTelegramDelivery` method
and `ackTelegramDelivery()` domain function DELETED. The ONE production
mutation path is `POST /api/telegram-deliveries/:id/transition` →
QUEUED→SENDING→SENT|FAILED|UNKNOWN. `workforce/messages/:id/ack` is a
different, unrelated endpoint (unchanged). Test §13: controller has no
`ackTelegramDelivery`; QUEUED→SENT request throws
`FAIL_CLOSED_TELEGRAM_DELIVERY_TRANSITION`, slot stays QUEUED.

## §6 — strict legal-transition matrix → closed

Illegal transitions throw `FAIL_CLOSED_TELEGRAM_DELIVERY_TRANSITION` —
never silent no-ops: QUEUED→SENT, SENT→SENDING, UNKNOWN→SENDING,
UNSENDABLE→SENT all reject; SENDING→SENT additionally requires valid
`message_id` (§2); QUEUED→SENDING rejected when `attempt_count>=max`
or `next_retry_at>now` (BACKOFF_PENDING/BUDGET_EXHAUSTED reasons).
Idempotent replay of the same in-flight `SENDING` begin returns the
existing attempt unchanged.

## §7 — deterministic attempt identity → closed

`Date.now()` removed from the canonical transition. `beginDeliveryAttempt`
persists `attempt_number = attempt_count+1` and
`attempt_id = ATT_<digest(delivery_id:slot:attempt_number)>` — same
inputs → same id, idempotent replay verified in test §14.

## §8 — TEXT ≡ FILES lifecycle → closed

TEXT payload uses request-level slot fields (`text_state`,
`attempt_count`, `max_attempts`, `next_retry_at`, `attempt_id`,
`message_id`, `last_error`, `unknown_reason`) flowing through the exact
same `slots()` view + transition functions as FILES artifacts.

## §15 — R3 proofs preserved

All 48 R1–R3 focused tests pass unchanged (only §14A retry assertion
extended to assert the new `attempt_count`/`next_retry_at` backoff
semantics — the retry path now correctly flows through the eligibility
gate instead of re-sending instantly).

## §16 — regression (Node 22)

| Surface | Result |
|---|---|
| Focused incident (R1–R4) | **58/58 PASS** (48 R1–R3 + 10 R4: §9 ×2, §11 ×4, §12 ×2, §13–14 ×2) |
| pair-ops-telegram-delivery | 3/3 PASS |
| Phase B / PR#23 / Phase C / Phase D | 123 + 20 + 51 + 37 PASS |
| **Full suite** | **2621 pass / 2 fail env P5 cũ / 15 skipped** (R3 2611 → +10, zero regression — same 2 pre-existing DSH/CODEX probe env fails since base) |
| `npx tsc --noEmit` / `pnpm build` | clean / clean |

## §17 — changed files (R4)

- `src/pair/telegram-delivery.ts` — unified slot state machine +
  retry budget + strict transitions + deterministic attempt_id +
  eligible-only projection; `ackTelegramDelivery` deleted.
- `src/pair/telegram-transport.ts` — `ok`-without-message_id →
  `backend.unknown`; TEXT gated on `text_state===QUEUED`.
- `src/pair/env-config.ts` — `TG_DELIVERY_MAX_ATTEMPTS` +
  `telegramDeliveryMaxAttempts()` bounded helper.
- `src/pair/mission-runtime.ts` — `telegramDeliveryMaxAttempts` dep → mint.
- `src/pair/mission-control.ts` — `ackTelegramDelivery` deleted;
  `transitionTelegramDelivery` gains optional deterministic `now`.
- `src/pair/mission-control-server.ts` — `/ack` route deleted.
- `scripts/serve-mission-control.mjs` — `PAIR_TG_DELIVERY_MAX_ATTEMPTS` wiring.
- `scripts/telegram-bridge.mjs` — `governedSend` validates message_id.
- `src/__tests__/pair-planner-dataflow-incident.test.ts` — +10 R4 tests;
  runTransport/storeBackend gain injected `now`; recordingTransport
  `noMid` mode.
- `PAIR_NEXT_PLANNER_DATAFLOW_INCIDENT_REMEDIATION_REPORT.md` — this section.

## §18 — 8 proofs

1. Stale TEXT SENDING → `UNKNOWN_SIDE_EFFECT` → zero resend (§9).
2. `ok` without message_id → NOT SENT for TEXT, txt, binary; server
   `to=SENT` without id rejects (§11).
3. Repeated definite failure stops at ceiling → `FAILED_DELIVERY`
   terminal, zero sends forever (§12).
4. Poll before `next_retry_at` → not projected, zero calls (§12).
5. `/ack` gone — QUEUED→SENT without SENDING fails closed (§13).
6. Illegal matrix QUEUED→SENT / SENT→SENDING / UNKNOWN→SENDING /
   UNSENDABLE→SENT all fail closed (§14).
7. Success persists real `message_id` + `completed_at` (§14D/§11).
8. All R3 invariants PASS — manifest scope, negation, origin binding,
   allowlist-not-broadcast, non-telegram-no-default→UNSENDABLE, no
   outbox scan, completion≠send, DEVIN upload≠send, pre-dispatch
   missing-input, reserved fields, no `.sent` (48/48 preserved).

Final classification: `PAIR_NEXT_PLANNER_DATAFLOW_INCIDENT_REMEDIATION_R4_PENDING_INDEPENDENT_AUDIT`

STOP. DO NOT MERGE. DO NOT START PHASE E.

---

# R5 — Final aggregate-state + evidence closure (audit `pasted-<R5 mandate>`)

Base: audited R4 HEAD `7241313` · same PR #27 · narrow final closure — no
redesign of R1–R4.

## §1-2 — canonical request aggregation (BLOCKER) → closed

`recomputeStatus` now implements the mandated aggregate over the uniform
slot states — QUEUED only while ≥1 payload can still make canonical
automatic progress (`SENDING`, or `QUEUED` with budget left, including
bounded-backoff-pending). Once nothing progressable remains:
`UNKNOWN_SIDE_EFFECT` dominates `FAILED_DELIVERY`, which dominates the
SENT mix — SENT + FAILED → `FAILED_DELIVERY`; SENT + UNKNOWN or
FAILED + UNKNOWN → `UNKNOWN_SIDE_EFFECT`; all SENT → `SENT`. Per-slot
evidence is never flattened; SENT payloads never resend.

## §3 — stale reconcile recomputes request status → closed

`reconcileStaleDeliveryAttempts` now persists
`recomputeStatus` after flipping stale `SENDING` slots — a single stale
TEXT/FILE payload yields request `UNKNOWN_SIDE_EFFECT`, never dead
QUEUED.

## §4-5 — strict Telegram message_id (BLOCKER) → closed

`isValidTelegramMessageId(mid) = Number.isSafeInteger(mid) && mid > 0`
(Bot API `Message.message_id` is an Integer). Enforced at BOTH layers:
transport `ok` + invalid/missing id → `backend.unknown`
(`acceptance_unproven`); domain `SENDING→SENT` + invalid id →
`FAIL_CLOSED_TELEGRAM_DELIVERY_EVIDENCE`. Rejected everywhere:
`undefined null "" "MID_fake" "123" 0 -1 1.5 NaN`. Bridge
`governedSend` uses the same check; test transport now returns realistic
numeric ids (`1001`).

## §6 — unresolvable manifest artifact converges (BLOCKER) → closed

In `pendingTelegramDeliveries`, an eligible FILES slot whose canonical
name cannot resolve (no exact outbox file, no unique remote-upload
prefix match, no workspace-staged copy — producers canonically complete
because the request exists) converges to `FAILED_DELIVERY` with
`last_error = FAIL_CLOSED_TELEGRAM_ARTIFACT_UNRESOLVED` + request status
recomputed — never polled forever, never a network call burned. No
path guessing, no broadened matching; unique-prefix resolution kept.

## §7-13 — required tests

| Test | Result |
|---|---|
| §7 mixed SENT + FAILED (b.txt hits ceiling) → `FAILED_DELIVERY`, pending `[]`, zero sends | PASS |
| §8 mixed SENT + UNKNOWN → `UNKNOWN_SIDE_EFFECT`, a never resends | PASS |
| §9 FAILED + UNKNOWN → `UNKNOWN_SIDE_EFFECT` (ambiguity dominates) | PASS |
| §10 backoff-pending keeps request `QUEUED`; before expiry pending `[]`; after expiry only b projects | PASS |
| §11 stale single-FILE SENDING → slot + request `UNKNOWN_SIDE_EFFECT` (+ §9 TEXT) | PASS |
| §12 strict message_id: 7 invalid values → UNKNOWN at transport; 9 → throw at domain; `1001` → SENT `message_id=1001` | PASS |
| §13 unresolved artifact → `FAILED_DELIVERY` + `FAIL_CLOSED_TELEGRAM_ARTIFACT_UNRESOLVED`, zero network calls | PASS |

## §14 — R1–R4 preserved

58 R1–R4 focused tests pass unchanged (retry/assertions updated only for
the new strict-id + aggregate semantics: numeric mid `1001`, TEXT stale
asserts request `UNKNOWN_SIDE_EFFECT`).

## §15 — regression (Node 22)

| Surface | Result |
|---|---|
| Focused incident (R1–R5) | **65/65 PASS** (58 + 7 R5) |
| **Full suite** | **2628 pass / 2 fail env P5 cũ / 15 skipped** (R4 2621 → +7, zero regression — same 2 pre-existing DSH/CODEX probe env fails since base) |
| `npx tsc --noEmit` / `pnpm build` | clean / clean |

## §16 — changed files (R5)

- `src/pair/telegram-delivery.ts` — `isValidTelegramMessageId`,
  `progressable()` + 5-rule `recomputeStatus`, stale reconcile → status
  recompute, unresolved-artifact convergence in the pending projection.
- `src/pair/telegram-transport.ts` — strict positive-safe-int mid check.
- `scripts/telegram-bridge.mjs` — `governedSend` strict mid check.
- `src/__tests__/pair-planner-dataflow-incident.test.ts` — +7 R5 tests;
  numeric mid (`1001`); `midOverride` transport option; `mintFilesRequest`.
- `PAIR_NEXT_PLANNER_DATAFLOW_INCIDENT_REMEDIATION_REPORT.md` — this section.

## §17 — explicit proofs

1. SENT + FAILED → request `FAILED_DELIVERY`, not dead QUEUED (§7).
2. SENT + UNKNOWN → `UNKNOWN_SIDE_EFFECT` (§8); FAILED + UNKNOWN →
   `UNKNOWN_SIDE_EFFECT` (§9).
3. Backoff-pending slot keeps request `QUEUED`; not projected before
   `next_retry_at`; only that slot projects after (§10).
4. Stale TEXT/FILE SENDING → slot `UNKNOWN_SIDE_EFFECT` AND request
   `UNKNOWN_SIDE_EFFECT` (§11, R4 §9 updated).
5. Fake/string/zero/negative/fractional message_id cannot produce SENT
   — transport UNKNOWN, domain throws (§12).
6. Positive integer `1001` produces SENT with `message_id=1001` (§12).
7. Unresolved manifested artifact → `FAILED_DELIVERY` +
   `FAIL_CLOSED_TELEGRAM_ARTIFACT_UNRESOLVED`, zero network calls (§13).
8. All R1–R4 invariants PASS (65/65 focused, full suite zero regression).

Final classification: `PAIR_NEXT_PLANNER_DATAFLOW_INCIDENT_REMEDIATION_R5_PENDING_INDEPENDENT_AUDIT`

STOP. DO NOT MERGE. DO NOT START PHASE E.

---

# R6 — Fresh-vs-stale SENDING concurrency closure (audit `pasted-<R6 mandate>`)

Base: audited R5 HEAD `c073be9` · same PR #27 · narrow concurrency
closure — no redesign of R1–R5.

## §1-3 — lease-based stale reconciliation (BLOCKER) → closed

Root cause: `reconcileStaleDeliveryAttempts` treated EVERY durable
`SENDING` as crashed — a 5s-overlapping bridge poll could flip a
legitimately in-flight send to UNKNOWN_SIDE_EFFECT mid-request, so the
subsequent SENT transition then failed-closed and a real send was
falsely declared ambiguous.

`reconcileStaleDeliveryAttempts(store, now, staleAfterMs)` is now
LEASE-based on `attempt_started_at`: `age < staleAfterMs` → slot stays
`SENDING` (progressable, never reconciled, never re-projected);
`age >= staleAfterMs` → `UNKNOWN_SIDE_EFFECT` + request-aggregate
recompute (R5 semantics preserved). Canonical setting:
`PAIR_TG_DELIVERY_STALE_AFTER_MS` — bounded 5_000..600_000, default
60_000ms, parsed through env-config, injected via
`MissionControlDeps.telegramDeliveryStaleAfterMs` →
`pendingTelegramDeliveries`/`reconcile` (default fallback
`TELEGRAM_DELIVERY_DEFAULT_STALE_AFTER_MS` = 60_000).

## §4/§7 — bounded transport timeout → closed

`PAIR_TG_DELIVERY_TRANSPORT_TIMEOUT_MS` — bounded 1_000..300_000,
default 25_000ms, env-config. `transportTelegramDelivery({timeoutMs})`
races the governed send against the deadline: timeout after dispatch
began → `{kind:"unknown"}` → `UNKNOWN_SIDE_EFFECT` — never definite
failure, never blind retry, never silent success.
`assertTelegramDeliveryTiming` enforces TRANSPORT_TIMEOUT < STALE_AFTER
fail-closed at serve startup; bridge reads the canonical parse and
passes `timeoutMs`.

## §6 — bridge non-overlap (defense in depth) → closed

`makeNonReentrant(fn)` (telegram-transport.ts, exported): a second
interval trigger while a cycle is in flight is skipped; the DURABLE
SENDING lease remains the canonical correctness mechanism. Bridge:
`setInterval(() => void notifyGuarded(), 5000)`.

## §8 — missing/malformed attempt_started_at → closed

SENDING slot with missing or non-parseable `attempt_started_at` →
`UNKNOWN_SIDE_EFFECT` with durable reason
`stale_sending_missing_started_at` — never a fabricated fresh
timestamp, never a retry.

## §9-14 — required tests (5 new, 70 total)

| Test | Result |
|---|---|
| §9+§11 fresh SENDING + overlapping poll → stays SENDING, zero re-projection, SENT 1001 then lands | PASS |
| §10 SENDING older than lease → UNKNOWN_SIDE_EFFECT — TEXT and FILE identical, empty projection, zero resend | PASS |
| §12 transport timeout → bounded UNKNOWN_SIDE_EFFECT, not definite failure, zero retry | PASS |
| §13 missing/malformed attempt_started_at → UNKNOWN + `stale_sending_missing_started_at` | PASS |
| §14 `makeNonReentrant` — overlapping triggers run one cycle at a time | PASS |

Pre-existing crash-window tests (R3 A/B/D, R4 §9/§10, R5 §11) updated
to poll PAST the lease — they now prove the same reconciles are still
correct once attempts are actually stale.

## §15 — R1-R5 preserved: all 70 focused tests pass.

## §16 — regression (Node 22)

| Surface | Result |
|---|---|
| Focused incident (R1–R6) | **70/70 PASS** |
| **Full suite** | **2633 pass / 2 fail env P5 cũ / 15 skipped** (R5 2628 → +5, zero regression — same 2 pre-existing DSH/CODEX probe env fails) |
| `npx tsc --noEmit` / `pnpm build` | clean / clean |

## §17 — changed files (R6)

- `src/pair/env-config.ts` — `TG_DELIVERY_STALE_AFTER_MS` +
  `TG_DELIVERY_TRANSPORT_TIMEOUT_MS` (bounded, defaults 60s/25s) +
  `assertTelegramDeliveryTiming` (timeout < stale, fail closed).
- `src/pair/telegram-delivery.ts` — lease-based reconcile
  (`attempt_started_at` + staleAfterMs; missing/malformed stamp →
  UNKNOWN `stale_sending_missing_started_at`);
  `pendingTelegramDeliveries(store, now, staleAfterMs)`;
  `TELEGRAM_DELIVERY_DEFAULT_STALE_AFTER_MS`.
- `src/pair/telegram-transport.ts` — `timeoutMs` (timeout →
  `{kind:"unknown"}`) + `makeNonReentrant`.
- `src/pair/mission-control.ts` — `telegramDeliveryStaleAfterMs` dep →
  read path.
- `scripts/serve-mission-control.mjs` — parse + assert timing +
  dep wiring.
- `scripts/telegram-bridge.mjs` — transport `timeoutMs` +
  non-overlapping notify loop.
- `src/__tests__/pair-planner-dataflow-incident.test.ts` — +5 R6 tests;
  crash-window polls moved past the lease; R5 helpers hoisted module-level.
- `PAIR_NEXT_PLANNER_DATAFLOW_INCIDENT_REMEDIATION_REPORT.md` — this section.

## §18 — explicit proofs

1. Fresh SENDING + second poll → slot remains SENDING, request stays
   QUEUED, zero re-projection (§9).
2. Fresh SENDING then persists SENT with message_id=1001 (§9).
3. SENDING older than lease → UNKNOWN_SIDE_EFFECT — TEXT and FILE same
   rule, aggregate recomputed, empty projection (§10).
4. Transport timeout → UNKNOWN_SIDE_EFFECT bounded, never definite
   failure, zero retry (§12).
5. Missing/malformed attempt_started_at → UNKNOWN +
   `stale_sending_missing_started_at` (§13).
6. notifyLoop triggers never overlap (`makeNonReentrant`, §14).
7. All 65 R1–R5 focused tests PASS (70/70); full suite zero regression.

Final classification: `PAIR_NEXT_PLANNER_DATAFLOW_INCIDENT_REMEDIATION_R6_PENDING_INDEPENDENT_AUDIT`

STOP. DO NOT MERGE. DO NOT START PHASE E.
