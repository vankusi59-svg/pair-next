# F10 — Numeric Ceiling Enforcement Matrix

What is actually guaranteed at plan time (`assertPlanCoverage` /
`covers()`), what is preserved-unverified, and what is out of scope.
Every "enforced" row is backed by adversarial tests (H43+ block in
`pair-semantic-adversarial.test.ts`).

## Extraction (goal-contract.ts)

| Input form | Result | Notes |
|---|---|---|
| `không quá 50 USD` / `at most $50` | `ceiling{50,money,usd}` + `maxAmount=50` | typed ceiling |
| `tối đa 3 tác vụ` / `max 3 tasks` | `ceiling{3,task-count,tác vụ}` | |
| `at most 5 outputs/reports/files` | `ceiling{5,object-count,<noun>}` | noun bound |
| `budget max $500` | `ceiling{500,money}` | prefix currency types the bound |
| `no more than 100 requests` | `ceiling{100,object-count,requests}` | |
| `không hơn`, `nhiều nhất`, `không vượt quá`, `not more than`, `up to`, `<=`, `≤` | same | extended CONSTRAINT_RE |
| `1,000` / `1.000` grouped | parsed as 1000 | aligned with quantityNums digit-width |
| `trong 30 ngày`, `every 2 hours`, `100%`, `2026`, `v1.2` | **no ceiling** | duration/frequency/percent/year/version never mint bounds |
| `exactly 3 reports` | `quantity.min=3` (+max via exact form) | bound words stripped from identity anchors |

## Enforcement (plan-coverage.ts `covers()`)

| Ceiling kind | Evidence accepted | Over → | At/under → | No evidence → |
|---|---|---|---|---|
| money | task instruction amounts bound to currency units ($/usd/vnd/đồng/dollar/euro) | `FAIL_CLOSED_PLAN_CONSTRAINT_VIOLATION` | PROVEN | PRESERVED |
| task-count | plan task count | VIOLATION | PROVEN | PROVEN (count always known) |
| object-count | numbers bound to the same unit noun in task instructions; declared produced artifacts for file-like units | VIOLATION | PROVEN | PRESERVED |
| `quantity.max` on obligation (max-only) | subject-bound numbers | VIOLATION | — | strict: never PROVEN → INCOMPLETE |
| `quantity` exact form | subject-bound numbers | VIOLATION | PROVEN | contradiction-only |

## Invariants proven by tests

- A number not bound to the ceiling's unit/currency never satisfies or
  violates the bound ("100 requests" cannot affect "$50").
- Date/duration/year/version/filename numbers are masked — neither
  satisfy nor violate.
- Unverifiable hard bounds never PROVEN — fail-closed or PRESERVED.
- Ceiling clauses never mint `quantity.min` (backstop skip + strip).
- Advisory `pair_coverage` cannot flip outcomes; forged hints fail closed.
- Preview/confirm keep binding canonical `plan_digest`; replan unaffected.
- Zero new provider invocations.

## Explicit non-guarantees

- **Runtime enforcement**: actual spend/API-call/resource ceilings during
  execution are NOT enforced by this change. `SpendTracker` covers
  provider inference spend only. Mission-scoped runtime caps remain
  unsupported → documented, fail-closed where plan evidence exists.
- Cross-task money aggregation: per-mention max comparison (consistent
  with obligation semantics); plans that split 100 into 2×60 vs a
  `≤100` ceiling are not summed — documented limitation.
- Currency conversion: `50 USD` ceiling vs `60000 VND` plan amounts —
  different units do not satisfy the bound (conservative: no fabricated
  conversion).
