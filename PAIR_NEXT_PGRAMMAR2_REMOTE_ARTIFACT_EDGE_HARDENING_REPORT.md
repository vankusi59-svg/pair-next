# P-GRAMMAR2 — Planner Remote Artifact Edge Hardening

**Base**: `main` @ `94243be` (post-PR #44 RPN-1 merge)
**Branch**: `devin/1791153146-pgrammar2-remote-edge-hardening`
**Status**: `PAIR_NEXT_PGRAMMAR2_REMOTE_ARTIFACT_EDGE_HARDENING_R1_PENDING_AUDIT`

## 1. Incident (live evidence, prod DB)

Goal: `nghiên cứu song song 2 hướng: (1) dùng một remote cloud executor …
viết đánh giá lưu vào outbox/automaton_review.md; (2) research … lưu vào
router_patterns.json; sau đó đọc outbox/automaton_review.md và
router_patterns.json, viết report.md so sánh, gửi report.md và
outbox/automaton_review.md qua telegram`

Two consecutive missions died `FAIL_CLOSED_PLANNER_EXHAUSTED` before any
task ran. `planner_attempt` rows (prod `pair.db`, `entities` table):

- Attempt #1 `codex-cli:gpt-6.1-sol` → `PLAN_INVALID`,
  `DROP_REMOTE_DEPENDENT:T3`/`T4` — the emitted aggregation task declared
  `depends_on` the remote producer but paraphrased the artifact path away
  ("tổng hợp kết quả từ các nguồn…"), leaving no consume edge. F2 §20
  gate rejected correctly — the plan was genuinely unsound.
- Attempt #2 `gemini:3.1-flash-lite` → `PLAN_INVALID`,
  `CANONICAL_VALIDATION_FAILED` — the typed IntegrityError code was
  swallowed; only the generic class reached the attempt row.
- Attempt #3 `badq` → `MALFORMED_RESPONSE` / unservable caps.

The operator-visible failure was a planner *lottery*: the same goal
succeeded whenever gemini happened to copy the literal path, failed
whenever it did not (4/4 sol rejections, 1/2 gemini).

## 2. Root cause

F2 §20 (`sanitizePlan` remote-dependent gate) was correct and stays
correct: a non-delivery task depending on a remote task must extract a
consume edge against that dep's produces or the task is dropped
fail-closed. The defect was entirely on the emission side — planner
candidates paraphrased goal-stated artifact paths out of consumer
instructions, and nothing repaired the unambiguous omission or recorded
why canonicalize rejected.

## 3. Changes

### 3.1 `src/pair/llm-planner.ts` — prompt hardening (§1)

Added one bullet to the shared `SYSTEM_PROMPT` (`REMOTE EDGE EXAMPLES`):
a concrete VALID example (remote producer writes `outbox/review.md`;
consumer instruction literally reads it; `depends_on` includes the
producer) and a concrete INVALID example (`Tổng hợp kết quả từ các
nguồn…` — no literal path → REJECTED), plus the explicit rule that
paraphrases ("the results", "the output", "các nguồn") never constitute
an artifact edge. Single shared prompt — no second planner prompt.

### 3.2 `src/pair/llm-planner.ts` — deterministic bounded repair (§2)

At the remote-dependent gate, before dropping an offending task, a
canonical repair is attempted only when ALL hold:

- exactly ONE offending remote producer in `depends_on`;
- that producer extracts exactly ONE produced artifact;
- `edgesAllReal`: every consume edge the consumer already declared binds
  a real produce of one of its deps (a consumer naming an artifact no
  dep produces is incoherent → no repair, no guessing);
- the canonical suffix ` Input artifact to read: <path>.` fits
  `LLM_PLANNER_MAX_INSTRUCTION` without truncation.

Repair = append the suffix, re-run `candidateTaskDataflow`, require the
extracted edge to be real. Evidence: `REPAIRED_REMOTE_DEPENDENT_EDGE:<key>`
warning on the sanitize result. Anything ambiguous — >1 offending remote
producer, producer with 0 or >1 artifacts, incoherent existing edges,
budget overflow — preserves the existing fail-closed
`DROP_REMOTE_DEPENDENT:<key>` untouched. TELEGRAM_DELIVERY never enters
the block (existing exemption preserved).

A consumer that names ANOTHER dep's real artifact but omits the remote
one (the live incident shape — `router_patterns.json` bound, remote path
dropped) does repair: all declared edges are real, the single remote
omission is unambiguous.

### 3.3 `src/pair/planner-pool.ts` — typed observability (§3)

The `canonicalize` catch now extracts a bounded `code` property
(`/^[A-Z0-9_:.\-]+$/`, ≤80 chars) and persists `VALIDATION_CODE:<code>`
in the attempt warnings alongside the preserved
`CANONICAL_VALIDATION_FAILED` marker. Warning list stays bounded
(≤10 entries: 8 res warnings + coded + marker). Arbitrary messages,
stacks, secrets, unbounded text are never persisted — untyped errors
persist exactly what they did before.

### 3.4 `src/__tests__/pair-pgrammar2-remote-edge.test.ts` — NEW (20 tests)

- **A** prompt contains valid + rejected examples, single shared prompt.
- **B** repair produces a real consume edge + `REPAIRED_…` warning +
  instruction carries path; suffix-only extraction; partial-omission
  (incident shape); idempotent.
- **C** fail-closed matrix: 2 produces via `metadata.pair_dataflow`, two
  offending remote deps, zero produces, invented foreign artifact, budget
  overflow, local deps unchanged, TELEGRAM_DELIVERY exempt, already-named
  untouched.
- **D** typed IntegrityError → `VALIDATION_CODE:FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT`
  + `CANONICAL_VALIDATION_FAILED`, no secret leak; untyped error → no
  code, no message/stack leak.
- **E** F2 regression + E3 live incident shape end-to-end: paraphrased
  aggregation → `REPAIRED_REMOTE_DEPENDENT_EDGE:T4`, repaired instruction
  carries `outbox/automaton_review.md`, and the sanitized plan passes
  `reconcilePlanDataflow` with the incident goal's telegram intent —
  the committed-plan authority unchanged.

## 4. Non-goals honored

`assertPlanDataflow` not weakened; no remote dep without a real edge;
`artifactNamesEquivalent`, DSN-1, F1, F4, F5, RPN-1, telegram, routing,
capabilities untouched; no second planner prompt; no LLM/parser repair
service; no silent repair of ambiguous relationships.

## 5. Validation (real output)

- `pnpm vitest run src/__tests__/pair-pgrammar2-remote-edge.test.ts` →
  **26/26 pass** (20 initial + 6 R1 tests).
- Focused regression (13 files): **642/642** — pgrammar2-remote-edge 26,
  llm-planner 16, prv2a 59, prv2b 51, f5-remote-producer-closure 74,
  planner-dataflow-incident 125, phase-b 123 (planner failover),
  dsn1 11, f2-artifact-handoff 53, f2-r1 43, f2-r2 35, f2-r3 18,
  f2-r4 8; plus cpl1-codex-planner **49/49**.
- `pnpm tsc --noEmit` → clean.
- `rm -rf dist && pnpm build` → clean.
- `pnpm audit` → 9 vulns (1 low, 8 moderate, 0 high) — identical to
  baseline on main.
- Full suite `pnpm vitest run` → **3549 pass / 2 failed** / 24 skipped
  (3575 total) — the 2 known env-only P5 stock-adapter probe cases
  (DSH/CODEX executables exist on this VM), identical to the `94243be`
  baseline.

## 6. Live reproduction (R1, scratch stack `pair-mc-pgrammar2-r1` @ :8799)

Honest distinction: the E3 test in section 3.4 is a deterministic
incident-SHAPE test, not a live repro. Actual live evidence below comes
from the real configured planner preview/mission path on a scratch
instance running this branch's build (codex-cli sol → gemini → badq,
same routes/timeouts as prod).

### 6.1 Repair fires on real planner output, durably

`POST /api/missions/preview` + `POST /api/missions` with the exact
incident goal and a simplified remote→consume variant. Across 15 real
planner attempts, `REPAIRED_REMOTE_DEPENDENT_EDGE:<key>` was persisted
on 6 attempts (codex 3, badq 1, gemini 2) — PAIR-authored instruction
rewrites are now provably distinguishable in durable
`planner_attempt.warnings`. Codex's omission pattern is stable: it
emits the remote-dependent aggregation without the artifact path, the
repair appends ` Input artifact to read: outbox/automaton_review.md.`,
and the attempt row keeps both the marker AND the typed downstream code.

### 6.2 VALIDATION_CODE delivers typed causes on every rejection

Every canonicalize rejection now carries its exact IntegrityError code —
`FAIL_CLOSED_DELIVERY_VERB_IN_NON_DELIVERY_TASK`,
`FAIL_CLOSED_PLAN_DATAFLOW_UNGOVERNED_REMOTE_EDGE`,
`FAIL_CLOSED_PLAN_DATAFLOW_ORDER`, `FAIL_CLOSED_PLAN_INCOMPLETE`,
`FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT`,
`FAIL_CLOSED_DELIVERY_TASK_AMBIGUOUS` — alongside
`CANONICAL_VALIDATION_FAILED`. The previously opaque gemini failure is
now identifiable as a coverage rejection.

### 6.3 READY canonical preview reached with real consume edge

`preview-nodeliv` run (remote produce → local consume, no delivery
clause): attempt #1 codex `REPAIRED_REMOTE_DEPENDENT_EDGE:T2` then
failed on a second ungoverned remote dep (repair correctly refuses
multi-violation plans); attempt #2 gemini SUCCESS → READY preview
`MPP_01M44J7XV75QW87T6CMES8XKQM`. The canonical aggregation task T3:
`depends_on:["T2"]`, instruction `Read outbox/automaton_review.md,
synthesize …`, `metadata.pair_dataflow.consumes:["outbox/automaton_review.md"]`
— a REAL consume edge against remote producer T2's declared produce.

### 6.4 Incident-goal preview outcome (3 runs, 9 attempts)

The exact compound incident goal still ends
`FAIL_CLOSED_PLANNER_EXHAUSTED` on this pool — but at OTHER canonical
gates, each now typed and durable: codex repeats the remote-edge
omission (repaired) then trips R8 delivery-verb hygiene / a second
ungoverned remote dep; gemini fails goal-contract coverage
(`FAIL_CLOSED_PLAN_INCOMPLETE`); badq degenerates
(`LLM_PLAN_NO_JSON`, unservable caps, ambiguous delivery task). The
remote-edge lottery leg this phase targeted is repaired; the remaining
exhaustion legs are other planner-emission weaknesses, now observable.

### 6.5 Controlled mission executions (F5/RPN-1 path, 3 runs)

`POST /api/missions` on the simplified goal (`remote executor clones
Conway-Research/automaton → outbox/automaton_review.md; then read it →
summary.md`). Three committed missions, all outcomes durable:

1. `MSN_01M44JAK60MNN6T05R7H2DQ081` — DEVIN remote exec COMPLETED but
   uploaded 0 artifacts → `FAIL_CLOSED_REMOTE_PRODUCES_INCOMPLETE:
   outbox/automaton_review.md` → REPLAN ×2 → ABORT → FAILED. Root cause
   was MY scratch-env misconfig: `PAIR_OUTBOX_URL=http://localhost:8799`
   is unreachable from the Devin cloud VM — the F5 gate behaved
   correctly (zero uploads = incomplete produces, fail-closed).
2. `MSN_01M44K4671GBFACTTZN8GGT2HJ` — codex won with a clean plan, but
   its remote task T2 instruction contained F5's own upload clause
   ("Upload outbox/automaton_review.md … so downstream agents can
   READ it"), so the consume extractor attributed
   `consumes:[outbox/automaton_review.md]` to T2 itself — a self-consume
   edge on an artifact nothing produced before T2 →
   `PLAN_DATAFLOW_UNBOUND` at T2 dispatch → DEPENDENCY_FAILURE →
   REPLAN ×2 → ABORT → FAILED. Failed BEFORE any remote spend (correct
   fail-closed, zero cost). NEW finding, see §8.
3. `MSN_01M44KCDQ7TGDQ73VGMMGG0TSK` — **COMPLETED end-to-end**.
   codex attempt FAILED with durable `REPAIRED_REMOTE_DEPENDENT_EDGE:T2`
   + `VALIDATION_CODE:FAIL_CLOSED_PLAN_DATAFLOW_UNGOVERNED_REMOTE_EDGE`;
   gemini attempt SUCCESS (clean) → committed plan T2
   `produces:[outbox/automaton_review.md]`, T3
   `consumes:[outbox/automaton_review.md]` + `depends_on:[T2]`.
   DEVIN exec `EXE_c6e701dc5cd49d35` COMPLETED → uploaded
   `outbox/automaton_review.md` (19,695 B) via REMOTE_UPLOAD → ACCEPTED;
   `execution_validation` XVLD_01M44KMTBHS2J2PCXX54ZMDVD5 PASS with
   `remote_produces_missing: []` → **F5 declared_produces closure PASSED
   on a live remote upload**. `artifact_handoff` rows HOFF_552f…
   (consumer DEEPSEEK_HARNESS — task attempt failed) and HOFF_4536…
   (consumer CODEX — COMPLETED) → **governed handoff delivered the
   remote artifact to the consumer across an executor failover**.
   T3 produced `summary.md` ACCEPTED → mission COMPLETED.

This satisfies the mandate's live proof: real configured planner preview
path reached READY canonical previews (`MPP_01M44J7XV75QW87T6CMES8XKQM`,
`MPP_01M44KCDQ6ND2F8269YPR3Q8GQ`), the canonical aggregation task
carries the real remote consume edge, repair provenance is durable on
real attempts, and a controlled mission passed F5/RPN-1 closure plus the
governed handoff — no delivery authority weakened or bypassed.

## 7. R1 changes (audit findings on `a41137a`)

### 7.1 R1.A — durable repair evidence (`planner-pool.ts`)

`SUCCESS` settle now uses `boundedAttemptWarnings()` instead of
`slice(0, 10)`: the durable set stays ≤10 and in original order, every
`REPAIRED_REMOTE_DEPENDENT_EDGE:` marker is retained, earliest
non-repair warnings fill the remaining budget — deterministic, no
duplicates, never unbounded. Repair provenance can no longer be evicted
by a long warning tail.

### 7.2 R1.B — VALIDATION_CODE exact identity (`planner-pool.ts`)

The canonicalize catch reads the RAW `e.code` string and persists
`VALIDATION_CODE:<code>` only when the original is non-empty, ≤80 chars,
and matches `^[A-Z0-9_:.\-]+$`. An 81-char or malformed code persists NO
code instead of a truncated fabrication. `CANONICAL_VALIDATION_FAILED`
always still lands; messages/stacks/secrets never persist.

### 7.3 R1 tests (6 new, all in the focused file)

- R1.A1: >10 earlier warnings before repair — SUCCESS attempt keeps ≤10
  warnings, retains `REPAIRED_REMOTE_DEPENDENT_EDGE:T51`, canonical task
  is the repaired one (instruction carries the artifact path), replay
  produces the identical bounded set.
- R1.A2: `boundedAttemptWarnings` — order preserved, earliest non-repair
  fill the budget, repair markers never evicted, ≤10 input unchanged.
- R1.B1–B4: 80-char code → retained verbatim; 81-char → omitted (not
  truncated); invalid-charset → omitted; ordinary IntegrityError code →
  exact value; warning count ≤10 throughout.

## 8. Residual findings

- The exact incident goal still cannot be planned by this model pool —
  remaining legs: R8 delivery-verb hygiene violations by codex (delivery
  clause merged into a non-delivery task), coverage misses by gemini,
  badq degeneration, and multi-violation remote plans the bounded repair
  correctly refuses to guess at. These are planner-emission weaknesses
  outside this mandate's scope; all are now typed in durable evidence.
- NEW live finding (out of scope, fail-closed already): the consume
  extractor attributes an artifact name appearing after `read`-verbs in
  the remote PRODUCER's own instruction (the F5 mandatory upload clause
  says "so downstream agents can read it") as a self-consume edge →
  `PLAN_DATAFLOW_UNBOUND` at dispatch → DEPENDENCY_FAILURE → ABORT
  (mission `MSN_01M44K4671GBFACTTZN8GGT2HJ`). The plan committed because
  canonicalize sees a declared produce for that name on the same task;
  the unbound input is only provably unresolvable at dispatch. This is a
  planner-emission/extraction defect class distinct from R1 — recommend
  a dedicated mandate (e.g. self-consume suppression or
  producer-instruction hygiene).
- DEVIN remote execution evidence for this run is recorded in §6.5
  (F5/RPN-1 closure + governed handoff proven live on mission
  `MSN_01M44KCDQ7TGDQ73VGMMGG0TSK`); F5 suite stays green (74/74).
