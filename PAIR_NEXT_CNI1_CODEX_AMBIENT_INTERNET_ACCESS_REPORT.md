# CNI-1 — CODEX Ambient Unrestricted Internet Access (Option B+)

Classification: `PAIR_NEXT_CNI1_CODEX_AMBIENT_INTERNET_ACCESS_PENDING_AUDIT`

## 1. Identity

| Field | Value |
|---|---|
| Base | `5287965fc4a075ae064f21b74b88bb3041536319` (main after DSN-1 R1 merge) |
| Branch | `devin/1791076891-cni1-codex-ambient-internet` |
| PR | (created after this report is committed) |
| HEAD | (see PR) |

## 2. Decision implemented

Operator-selected **Option B+**: ambient CODEX internet authority is a **server-level
environment switch**, resolved **per dispatch**, never cached, never granted through
task permissions, never visible to the spawned child.

- `PAIR_CODEX_NETWORK` — truthy set: `on | true | 1` (trim + case-insensitive).
  Every other value (`unset`, `""`, `off`, `false`, `yes`, `enabled`, `2`, garbage)
  resolves **OFF** — fail-closed, identical to pre-CNI-1 behavior.
- One resolved boolean (`netAllowed`) per `dispatch()` drives **both** knobs:
  `permissions.<profile>.network.enabled=<bool>` **and** `web_search=live|disabled`
  — a single value, never split state.
- Applied to **both** permission profiles (`pair_read`, `pair_workspace`) — profile
  selection logic unchanged.
- Dispatch log line `CODEX_NETWORK: on|off` emitted per dispatch attempt.
- `PAIR_CODEX_NETWORK` is **not** in `childEnv()`'s whitelist → never propagated to
  the spawned `codex` process (fixture-proven: `codex_network_env === null`).
- `scripts/start-pair-live.sh` server env: `PAIR_CODEX_NETWORK="${PAIR_CODEX_NETWORK:-on}"`
  — prod default ON, operator override `PAIR_CODEX_NETWORK=off` respected. No
  secrets exported.

### Upstream contract correction found by live smoke

The codex CLI `web_search` config accepts `disabled|cached|indexed|live` — the
first implementation emitted `web_search=enabled`, which real codex rejects at
config load (`CODEX_EXIT_1`, all 4 first smoke dispatches). Corrected to
`web_search=live` for ON. The fake-codex fixture could not catch this; §13 caught
it against the real binary. OFF (`web_search=disabled`) was already valid and is
unchanged — P5 test 6 (real CLI dispatch) still passes under it.

## 3. Files changed

| File | Change |
|---|---|
| `src/pair/codex-adapter.ts` | `codexNetworkAllowed()` resolver (envReader seam); `permissionArgs(task, netAllowed)` binds `network.enabled`; dispatch resolves + logs `CODEX_NETWORK` + emits `web_search=live|disabled` |
| `scripts/start-pair-live.sh` | `PAIR_CODEX_NETWORK="${PAIR_CODEX_NETWORK:-on}"` in server env block |
| `src/__tests__/fixtures/fake-codex-argv.mjs` | new fixture: emits codex JSONL protocol, writes `{status, summary, argv, codex_network_env}` to `--output-last-message` |
| `src/__tests__/pair-cni1-codex-network.test.ts` | 22 adversarial tests (A–H + child-env isolation) |

## 4. Effective argv (both modes)

OFF (identical to pre-change):

```
--config approval_policy=never
--config web_search=disabled
--config permissions.pair_read|pair_workspace.network.enabled=false   (one profile)
```

ON:

```
--config approval_policy=never        (unchanged)
--config web_search=live
--config permissions.<profile>.network.enabled=true
```

Test F proves the normalized argv diff between ON and OFF is **exactly** these two
literals, and `argv_sha256(ON) ≠ argv_sha256(OFF)` — the digest is causal evidence
of the effective flags on that dispatch.

## 5. Test matrix (A–H), `pair-cni1-codex-network.test.ts` — 22/22 PASS

- **A** truthy variants: `on`, `ON`, `On`, `true`, `TRUE`, `1`, `" on "`, `"\ttrue\n"` → `network.enabled=true` + `web_search=live` (both profiles covered across A/G).
- **B** fail-closed: `unset`, `""`, `off`, `false`, `yes`, `enabled`, `2`, `garbage-!!` → `network.enabled=false` + `web_search=disabled`; exact-literal OFF lock (exactly one `network.enabled` config arg).
- **C** profile/flags regression under ON: `filesystem`, `workspace_roots`, `allowed_paths`, `approval_policy=never`, `--ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules --strict-config` unchanged.
- **D** dispatch precondition regression under ON: missing field / routing mismatch / non-authorized / missing workspace / unqualified → still rejected, no spawn.
- **E** no sticky cache: same adapter instance ON → OFF → `1` across 3 dispatches; each dispatch re-reads env.
- **F** argv causality: normalized argv differs only in the two net literals; `argv_sha256` differs; no raw secret strings anywhere in argv/journal.
- **G** both profiles: `pair_read` (no write perm) and `pair_workspace` (FILE_WRITE) each get their own `network.enabled` from the same `netAllowed`.
- **H** OFF regression lock: OFF argv is byte-identical to the pre-CNI-1 construction for the same task.
- Child env: spawned process env contains **no** `PAIR_CODEX_NETWORK` (`codex_network_env === null` in fixture final.json).

## 6. Boundaries preserved (verified, not asserted)

- No new mission/granted/governed permission; `FAIL_CLOSED_PERMISSION_EXPANSION`
  untouched; `NETWORK_EGRESS` approval path untouched (unused by B+).
- No planner, router, route-selection, capability, feasibility, recovery, or
  prompt changes. No gate changes. No second evidence entity — `argv_sha256`
  remains the argv evidence under `execution_journal.json`.
- Input bytes/prompt unchanged; workspace roots, filesystem profile, timeouts,
  output schema, snapshots, artifact collection all byte-identical.

## 7. Live smoke (§13) — scratch prod-shape stack

Scratch server: `serve-mission-control.mjs` (dist build), `PAIR_MC_DIR=/home/ubuntu/pair-mc-cni1`,
port 8899, `CODEX_HOME=~/.codex` (real codex auth), `PAIR_DSH_HOME` (real routes),
planner pool `gemini-3.6-flash`/`3.1-flash-lite` (real probes), **no**
`PAIR_DEVIN_API_KEY` (isolates routing to local executors), scratch workspace
`/home/ubuntu/pair-mc-cni1/workspaces/ws1`.

### ON run — `PAIR_CODEX_NETWORK=on`

- Mission `MSN_01M42AGWE5RH3AJT7RDH2RQZRN` — plan: T1 `PAIR_NATIVE` (record goal),
  T2 `FILE_OPERATIONS + PYTHON_EXECUTION` → `net_probe.txt` → **routed CODEX**
  (`ROUTE_DECISION_RECORDED executor_id=CODEX`; PYTHON_EXECUTION is CODEX-only).
- Dispatch log: `CODEX_NETWORK: on` (per dispatch; 4 lines incl. retries of the
  earlier invalid-config mission).
- Execution `EXE_1fdfa3516dac55807afb913123840fe7` COMPLETED; journal
  `argv_sha256=bf321c279d13f3f47ca95833…`, `run_root=/home/ubuntu/pair-mc-cni1/journal/codex/EXE_1fdfa…`.
- **Real fetch proof**: `net_probe.txt` (canonical artifact lane,
  `ARTIFACT_ACCEPTED` `byte_size=106`, `channel=LOCAL_EXECUTION`,
  `sha256=daa7d4054d…`, `producer_executor_id=CODEX`):
  ```
  2026-10-04T02:05:25.7208299
  https://timeapi.io/api/Time/current/zone?timeZone=UTC
  network fetch succeeded
  ```
  The datetime is the live API response (worldtimeapi.org was dead → endpoint
  switched to timeapi.io mid-smoke).
- `RESULT_VALIDATED PASS` → `TASK_COMPLETED` → `MISSION COMPLETED`.

### OFF run — `PAIR_CODEX_NETWORK=off` (same scratch stack, env flipped)

- Mission `MSN_01M42AX7NM645FD29E06KAACXM` — same goal shape, T2 routed CODEX.
- Dispatch log: `CODEX_NETWORK: off`.
- Execution `EXE_db019b0e117afc42ddb517164dd621fe` ran the real agent; sandbox
  denied egress: agent summary *"timeapi.io could not be resolved: Temporary
  failure in name resolution. No datetime was retrieved and net_probe.txt was
  not written."* → `net_probe.txt` never appeared in the workspace. Journal
  `argv_sha256=5545005145d01edc603c46ec…` ≠ ON digest.
- Same endpoint, minutes apart: ON fetched real data, OFF could not even resolve
  DNS — the flag reaches codex's network gate, in both directions, on the real
  binary.

## 8. Validation counts

| Gate | Result |
|---|---|
| Focused CNI-1 | **22/22 PASS** |
| `pair-p5` (real CLI dispatch incl. OFF argv) | 20/22 — 2 known env-only failures (tests 2–3 `stockProbe.available`, real `codex`/`dsh` binaries present on this VM; identical on base) |
| `pair-phase-c-dsh-model-routing` | PASS |
| `npx tsc --noEmit` | 0 errors |
| `rm -rf dist && pnpm build` | PASS |
| Full suite | (see final counts below) |
| `pnpm audit --audit-level=high` | 0 high |

## 9. Residual risks / debt

- Ambient scope: every CODEX dispatch gets net while `PAIR_CODEX_NETWORK` is ON —
  including a prompt-injected task. This is the operator-accepted Option B+
  trade-off; the OFF switch is the only mitigation short of a future
  permission-scoped variant (Option A).
- `web_search` variant names are upstream-contract-sensitive — the live smoke is
  the real guardrail (fixture tests cannot detect upstream enum changes).
- The small-model planner still produces malformed dataflow edges on some phrasings
  (preexisting — observed again during smoke goal iteration; unrelated to CNI-1).
