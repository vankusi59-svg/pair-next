# P18.3 Phase I — Collection Latency Benchmark (Before / After)

Method: `scripts/dev-verification/p183-benchmark.mjs` — real child-process
executions (`node fixtures/fake-codex-argv.mjs` spawned by the production
`CodexCliExecutorAdapter`) on the production object graph; only the model-facing
codex CLI is a fixture. Durable stamps measured: `finished_at` →
`first_terminal_observed_at` → `collection_committed_at` → `settled_at` →
task `COMPLETED`. Before side: `dist/` built from detached `905db0eb`
(merge head of PR #151) in a `git worktree`. After side: the P18.3 branch.
Tick cadence 100 ms both sides (the production supervisor sweeps every 1 s;
the wake hint is never required for settlement).

## Results

| Scenario | Base `905db0e` | P18.3 branch |
|---|---|---|
| **normal** (1 task, n=8) | settle median 20 ms, p95 27 ms, worst 27 ms (8/8) | settle median 19 ms, p95 31 ms, worst 31 ms (8/8) |
| **concurrent** (4 tasks, n=6 execs) | — (same fast path; not the bug) | collect-commit median 18 ms, p95 27 ms, worst 27 ms (6/6) |
| **starvation** (sibling terminal while runtime parked in `WAITING_APPROVAL` with a pending recovery — the RC-B/RC-A incident shape, n=3) | **0/3 settled within the 20 s limit — starved indefinitely** | **3/3 collected, median 21 ms, p95 30 ms, worst 30 ms** |

## Interpretation

- The normal single-execution path was never the bottleneck — it was always
  one observe tick (~1 s worst at production cadence). The reported delay
  lived in the starvation shapes from the forensic RCA (RC-A pending-recovery
  re-apply, RC-B state-gated observe, RC-C env-gated adapter). The measured
  base-side starvation trials reproduce exactly that: **0/3 ever settled** —
  consistent with the ~63-minute durable-evidence window in
  `P18_3_FORENSIC_ROOT_CAUSE.md` (task `version=7507` at ~2 writes/tick).
- Post-fix, every live runtime state collects: the starvation-shape sibling
  settles at the next tick (measured median 21 ms at a 100 ms cadence —
  i.e., bounded by the sweep period, not by minutes).
- Liveness stamps (`observe_count`, `first_terminal_observed_at`,
  `collection_started_at`, `collection_committed_at`, `collection_attempts`,
  `settled_at`) are null on the base build — they are the new P18.3 evidence
  surface; `finish_to_*` deltas on the base side are computed from wall
  clock at the driver.

## Reproduce

```bash
# after (this branch)
npx tsc && node scripts/dev-verification/p183-benchmark.mjs --scenario starvation --trials 3 --limit 20 --tick_ms 100
# before
git worktree add ../pair-base 905db0eb53e4288cd3b3c1a15dacab18fb2d2150
# junction node_modules, npx tsc, then run the same command inside ../pair-base
```

CPU/RAM overhead: the sweep reuses the existing per-tick store list (no new
scans — it shares the `executor_execution` list the RUNNING path already
did) plus one `observe()` per in-flight unsettled execution per tick;
adapters that report non-terminal return early (no collect, no fs walks
beyond the adapter's own journal read).
