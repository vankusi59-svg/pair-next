# P-GRAMMAR2 — Planner Remote Artifact Edge Hardening

**Base**: `main` @ `94243be` (post-PR #44 RPN-1 merge)
**Branch**: `devin/1791153146-pgrammar2-remote-edge-hardening`
**Status**: `PAIR_NEXT_PGRAMMAR2_REMOTE_ARTIFACT_EDGE_HARDENING_PENDING_AUDIT`

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
  **20/20 pass** (19 initial + E3 incident-shape).
- Focused regression (7 files): **497/497** — pair-llm-planner 16,
  prv2a 59, prv2b 51, f5-remote-producer-closure 74,
  planner-dataflow-incident 125, phase-b 123, cpl1-codex-planner 49.
- `pnpm tsc --noEmit` → clean.
- `rm -rf dist && pnpm build` → clean.
- `pnpm audit` → 9 vulns (1 low, 8 moderate, 0 high) — identical to
  baseline on main.
- Full suite `pnpm vitest run` → **3551 pass / 2 failed** — the 2 known
  env-only P5 stock-adapter probe cases (DSH/CODEX executables exist in
  this VM), identical to the `94243be` baseline.

## 6. Live repro (§6 acceptance)

Test E3 replays the incident shape through the real seams: sol-style
paraphrased aggregation task (`depends_on: [T2,T3]`, no remote path) is
repaired to `... Input artifact to read: outbox/automaton_review.md.`,
carries `REPAIRED_REMOTE_DEPENDENT_EDGE:T4`, keeps all 5 tasks, and
`reconcilePlanDataflow` (the committed-plan authority the serve
canonicalizer applies) accepts the plan with the goal's telegram intent.
Remote producer RPN-1/F5 `declared_produces` closure unchanged (F5 suite
74/74 green). Genuinely ambiguous variants (matrix C) still fail closed.

## 7. Residual findings

None new. The remaining planner-emission weakness (models inventing
unservable capability sets / malformed JSON — the other 2 exhaustion
legs) is outside this mandate's scope and unchanged.
