# P18.4 — Performance Benchmark

Baseline: P18.3 verified numbers (`docs/p18-3/P18_3_LATENCY_BENCHMARK.md`,
base `905db0e` → merged `9a1e363`). Method: same harness
(`scripts/dev-verification/p183-benchmark.mjs`) for the comparable
scenarios plus `p184-benchmark.mjs` for the new handoff path. Synthetic,
single-host, Windows — observed shapes only, not production-wide
guarantees.

## Comparable metrics (unchanged or better)

| Metric | P18.3 | P18.4 | Delta |
|---|---|---|---|
| Settle latency (median, normal path) | ~31ms | ~17ms | faster — collection split kept IO off the write lock; settle txn itself is local writes |
| Starvation shape (3 executions, 20s window) | 3/3 settled @ ~21–90ms | 3/3 settled @ ~20ms median | held — no regression into state-gated collection |
| Concurrent settle (2 executors) | ~20ms | ~17ms | held |

## New P18.4 metrics (6 trials)

| Metric | median | p95 | worst |
|---|---|---|---|
| Deferred→pending handoff txn wall time (`handoff_tick_ms`) | 5ms | 11ms | 11ms |
| Queue→arm end-to-end (`handoff_ms`, includes sibling recovery-cycle wait) | 1343ms | 1391ms | 1391ms |

The ~1.34s queue→arm figure is **not** the handoff cost — it is the
canonical single-slot wait: the deferred entry arms only after the
pending chain (retry dispatch + born-terminal settle + successor arm)
completes, which is governed recovery-cycle latency, unchanged by this
work. The atomic transaction itself is the ~5–11ms row.

## Resource/amplification notes

- Write amplification: the settle txn writes a bounded fixed set
  (exec row, task, runtime, decision, attempt, ≤2 events, optional
  scheduled_action/approval/send-request mint). No per-artifact writes
  beyond the pre-existing CAS path.
- Tick cost: sweep adds one `recovery_decision` list+map per sweep pass
  (upgrade-backfill witness set) — O(decisions-in-mission), small.
- The settle txn spans bounded local file IO (artifact persist/verify).
  Documented accepted tradeoff (audit F-residual); `busy_timeout` covers
  the single-writer object graph.
- No new timers, polls, or background loops were added; supervisor tick
  cadence is unchanged.

## Verdict

P18.3's collection-liveness improvements are preserved (no state-gated
collection, no polling regression) and the atomicity work adds ~5ms of
transaction wall time at the handoff boundary — within noise of a tick.
