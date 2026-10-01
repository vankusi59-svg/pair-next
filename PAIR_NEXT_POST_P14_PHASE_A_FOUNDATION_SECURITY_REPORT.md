# PAIR NEXT — POST-P14 PHASE A: FOUNDATION + SECURITY HARDENING

Classification: `PAIR_NEXT_POST_P14_PHASE_A_FOUNDATION_SECURITY_PENDING_INDEPENDENT_AUDIT`

## Lineage

- Base SHA: `2277319f26969a5c8f71f00731d09f6473c6f912` (canonical main, post-P14)
- R0 HEAD: `e1518e77fb82bc065bf0bf7bcbac8d4aeb59644a` (audited; `PHASE_A=BLOCKED, R1 REQUIRED`)
- R1 HEAD: set on push — see `git rev-parse HEAD` of `devin/post-p14-phase-a-foundation-security`
- Ancestry: branch is `base + Phase A commits only`. No merge, cherry-pick, or rebase of PR #17 / PR #18 — verified via `git log --oneline` (commits below are the full delta) and `git merge-base` = `2277319`.

## Commit list

| Commit | Scope |
|---|---|
| `ba06fdf` | A1 — validated env-config timeouts (probe/planner/task) |
| `a1ccdb9` | A2 — canonical model roles on model_entry identity |
| `2a99f23` | A3 — strict Planner∩DSH pool separation + runtime guards |
| `ef00a84` | A4 — MC token hardening via one canonical resolver |
| `88a1661` | A5 — focused tests + operator docs |
| `e1518e7` | A3 fix — DSH credential env from provider `apiKeyEnv` |
| *(new)* | R1 — canonical role reconciliation + final-state invariant + token file permission enforcement |

## Changed files (R0+R1, cumulative)

| File | Δ |
|---|---|
| `src/pair/env-config.ts` | +105 — `readPositiveIntEnv` canonical seam |
| `src/pair/model-role.ts` | +~430 — roles, identity, asserts, **R1: `reconcileModelRoleAssignments`, `assertCanonicalModelRoleStateDisjoint`** |
| `src/pair/mc-token.ts` | +~120 — `resolveMcToken`, **R1: 0600 enforcement on existing file** |
| `src/pair/dsh-adapter.ts` | +~60 — `modelRoleAssertion`, credential env from `apiKeyEnv` |
| `src/pair/mission-runtime.ts` | +10 — `taskTimeoutSeconds` dep, timeout resolution |
| `src/pair/mission-control.ts` | +12 — `model_role` field + `role_assignments` in `/api/models` |
| `src/pair/index.ts` | +~15 — exports |
| `scripts/serve-mission-control.mjs` | +~150 — config readers, token resolve, route pools, **R1: reconcile + final-state assert at startup**, planner binding removed from DSH pool |
| `scripts/telegram-bridge.mjs` | ~10 — shared `resolveMcToken` |
| `scripts/start-pair-live.sh` | ~15 — token resolution via resolver |
| `src/__tests__/pair-phase-a.test.ts` | +~750 — 40 R0 + 12 R1 focused tests |
| `README.md` | +~60 — operator docs |
| this report | new |

## Timeout design (Objective A)

`readPositiveIntEnv(name, defaultValue, {minMs|min,maxMs|max}, env)` — integer regex, `Number.isSafeInteger`, bounds, fail closed with `IntegrityError("FAIL_CLOSED_CONFIG_INVALID")` naming the variable and the rejection reason. Empty/unset → validated default.

| Env | Default | Bounds | Applied to |
|---|---|---|---|
| `PAIR_MODEL_PROBE_TIMEOUT_MS` | 8000 | 500–120000 | provider `PROTOCOL_PROBED` probes |
| `PAIR_LLM_PLANNER_TIMEOUT_MS` | 20000 | 2000–900000 | `planExpander` LLM planner call |
| `PAIR_TASK_TIMEOUT_S` | 120 | 5–7200 | `mission-runtime` per-task deadline |

All three are read once at startup in `serve-mission-control.mjs`; a malformed value aborts the boot before any side effect.

## Canonical role design (Objective B)

`model_role_assignment` entity — `MRA_<digest24(model_entry_id)>`, `role ∈ {PLANNER_COORDINATOR, DSH_EXECUTION, null}`, assignment on `model_entry_id` (never route spelling). DEFAULT-DENY: unassigned `modelRoleOf → null`; `assertModelRole` fails `FAIL_CLOSED_MODEL_ROLE_UNASSIGNED`/`_MISMATCH`/`_MODEL_NOT_USABLE`. Revocation is canonical: `role=null` + `revoked_from`/`revoked_at`/`revoked_by` (store is append-only — no delete).

## NEW — role reconciliation semantics (R1 §2–§4)

`reconcileModelRoleAssignments(store, {planner, dsh, actor})` — one canonical seam, executed inside `store.immediate()` (BEGIN IMMEDIATE … COMMIT/ROLLBACK):

1. **Desired-state validation before any mutation** — every configured ref must resolve to a real `model_entry` else `NotFound` (no partial topology; matrix F).
2. Desired pools must be disjoint on canonical identity — `assertNoModelRoleOverlap` including proven `model_alias_ids` cross-reference.
3. For every **active** stored assignment: desired-same → semantic no-op; desired-different → audited `MODEL_ROLE_REASSIGNED`; absent from desired → audited `MODEL_ROLE_REVOKED` (role=null).
4. For every desired ref lacking an active row → `MODEL_ROLE_ASSIGNED`.
5. Throws mid-way → transaction rolls back; no half-applied topology.

After boot-time reconciliation, active canonical assignments equal the current configured pools — not an accumulation of history. Historical changes survive in `governed_evidence` events.

## NEW — final-state disjointness invariant (R1 §3, §6)

`assertCanonicalModelRoleStateDisjoint(store)` loads **ACTIVE stored** assignments, partitions by role, and runs `sameCanonicalModel` (entry-id equality or proven alias cross-ref) pairwise over Planner×DSH — `FAIL_CLOSED_MODEL_ROLE_OVERLAP` with safe diagnostics on violation. Called at startup immediately after reconciliation; reusable by later Phase B/C runtime audits. This defends the audited attack: boot2 config `planner=C, dsh=B` where stale `A(planner)` is a proven alias of `B` — A is revoked by reconciliation before the stored-state assertion.

## Stale roles and routing (R1 §4)

The generic DSH binding loop excludes `modelRoleOf(...) === PLANNER_COORDINATOR`. Because reconciliation now drives removed-from-pool rows to `role=null`, only *current* planner assignments cause exclusion — persisted authority is the fix, not a bypass of it.

## Token design (Objective D)

`resolveMcToken({env, homeDir})`: explicit `PAIR_MC_TOKEN` (trimmed, nonempty) → `$PAIR_HOME|~ /pair-mc-token` → generated `crypto.randomBytes(32).hex` persisted mode 0600. `assertTokenShape`: empty/whitespace/padded → `FAIL_CLOSED_MC_TOKEN_INVALID`; known-static (`123`, `pair-mc-test-token`) in file/generated path → `FAIL_CLOSED_MC_TOKEN_WEAK` (env path is operator intent — allowed, per spec). Single seam shared by server, telegram bridge, and start script; token never written to canonical entities/events/logs.

## NEW — existing-file permission handling (R1 §7)

On the file path, POSIX platforms (`process.platform !== "win32"`): `stat` mode & 0777 ≠ 0600 → `chmodSync(0600)`; chmod failure → `IntegrityError("FAIL_CLOSED_MC_TOKEN_PERMS")`. Verified live: a 0644 file is tightened before read. Windows has no POSIX mode semantics — enforcement is skipped there by design (documented).

## Focused tests

`src/__tests__/pair-phase-a.test.ts` — **52 tests, all pass**:
- A timeouts: 11 (defaults, valid, NaN/Infinity/negative/zero/out-of-bounds, fail-closed naming)
- B/C roles + separation: 15 (assign/revoke/reassign CAS, asserts, planner∩DSH ∅ same-entry + proven-alias, exclusion, per-call asserts, model-not-usable)
- D token: 8 (precedence, generated+persist+0600+reuse, weak/empty/padded rejection, no-persistence-to-canonical)
- **R1 reconciliation: 7** (A remove-old-planner, B remove-old-dsh, C role swap w/ event audit, D proven-alias stale overlap, E idempotent restart zero-new-events, F unknown ref fails closed pre-mutation, atomicity rollback on desired overlap)
- **R1 final-state assertion: 3** (disjoint pass, stale-overlap fail, revoked rows excluded)
- **R1 token perms: 2** (0644→0600 enforcement, already-0600 unchanged)

## Full regression (Node 22)

| Suite | Result |
|---|---|
| `vitest run` (85 files) | **2285 pass / 2 fail / 15 skip** |
| `tsc --noEmit` | clean |
| `pnpm build` | clean |

The 2 failures (`pair-p5.test.ts` tests 2+3 — executor discovery) reproduce **identically on untouched base `2277319`** (verified in a clean worktree): the test masks only `~/.local` PATH dirs while dsh/codex live in `~/.nvm`. Pre-existing environment artifact, not introduced by this change. Node 20 is not canonical for this repo (engines require Node 22); skipped.

## Package audit

`pnpm audit`: 9 advisories (1 low, 8 moderate — esbuild/vite transitive dev deps via tsx). Unchanged from base (no dependency changes in this PR).

## Live evidence (isolated instance, /tmp/pair-r1-live, port 8793)

- **Boot 1** (`planner=gemini, dsh=cf+groq`): `MODEL_ROLE: reconciled {created:[3]}`; stored roles `gemini=PLANNER, cf=DSH, groq=DSH`; 3×ASSIGNED events. Token file written 0644 → enforced **0600** before read (`token-mode=600`).
- **Boot 2** (unchanged config): `{noop:[3]}` — zero new role events; topology preserved exactly (idempotent).
- **Boot 3** (`planner=cf, dsh=groq-only`): `{reassigned:[cf], revoked:[gemini], noop:[groq]}` — stored state: `gemini role=null revoked_from=PLANNER_COORDINATOR`, `cf=PLANNER_COORDINATOR`, `groq=DSH`; events +REVOKED +REASSIGNED. `assertCanonicalModelRoleStateDisjoint` → `DISJOINT_OK`.
- Negative cases (boot): same-spelling overlap, `PAIR_MODEL_PROBE_TIMEOUT_MS=abc`, known-static persisted token → all abort boot fail-closed with named errors.

## Known limitations / waivers

- **`settings.yaml → .imported` rename (dsh 0.2.0-rc.2)**: unchanged by R1 per spec §8 — deferred to the discovery phase. Operational note: restore `cp settings.yaml.imported settings.yaml` before a fresh boot or provider discovery yields 0 providers. Reconciliation is deterministic/restart-safe for whatever entries discovery actually produced.
- Explicit env token `PAIR_MC_TOKEN=123` remains accepted (operator intent escape hatch). Recommend dropping it on next restart to adopt the generated file token.
- SPA shows role data only via `/api/models`; no dedicated role column in the UI (informational).
- 2 pre-existing `pair-p5` env failures (above).
- Prod stack was restarted onto the Phase A build during E2E validation; its `pair.db` carries `REMOVED` conditions for cloudflare/groq → DSH unroutable there until catalog remediation (Phase B scope).

## Stop condition

Pushed to PR #19, **not merged**. Classification: `PAIR_NEXT_POST_P14_PHASE_A_FOUNDATION_SECURITY_PENDING_INDEPENDENT_AUDIT` — awaiting independent R1 re-audit.
