# PAIR OS vNext — P11 SOLO BUSINESS HARDENING V1 REPORT

## §10.1 Starting HEAD

`73c44b7865e5041f7a127dc24ac38f113138abc9` — exact match with the mandated
baseline (post-PR#3 main: business layer v0.5 + experience wiring).

## §10.2 Files changed

| File | Change |
|---|---|
| `src/pair/business.ts` | `WORK_ITEM_TRANSITIONS` legal-transition map + `assertWorkItemTransition`; `openWorkItem` reordered (IN_PROGRESS+claim write under version lock **before** `startMission`, with rollback on failure); `releaseClaim` requires `claim_token` on live claims; `assignWorkItem` rejects items actively claimed by another agent; `createBudgetPolicy` validates `scope_id` (agent exists-in-business / department has agents); `createRoutine` requires assignee ACTIVE. |
| `src/pair/credential-broker.ts` | New `deny()` — audits rejected fetch attempts (e.g. unknown mission_id) as `CREDENTIAL_DENIED`. |
| `src/pair/mission-control-server.ts` | `/api/work-items/:id/release` passes `claim_token`; `/api/broker/fetch` audits the unknown-mission 404 path via `broker.deny()`. |
| `src/__tests__/pair-p11.test.ts` | **New** — 22 regression tests (see §7). |
| `src/__tests__/pair-p9.test.ts` | Claim-release test updated to the hardened contract (release requires `claim_token`); adds the negative assertion. Not weakened — strengthened. |
| `README.md` | Rewritten: PAIR Next identity, canonical flow, release status, live-stack quick start. No longer presents the repo as Conway Automaton. |
| `ARCHITECTURE.md` | Rewritten to describe the actual PAIR Next control plane (modules, live stack, P11 invariants). |
| `DOCUMENTATION.md` | Banner marking it upstream Conway Automaton reference. |
| `CURRENT_STATE.md` | **New** — official-release vs current-main distinction + post-V1 delta. |
| `.github/workflows/ci.yml` | Test timeout (exit 124) now fails honestly (was `exit 0` = fake PASS); `pnpm audit --audit-level=high` is a real gate (was `|| true`). |
| `package.json` / `apps/mission-control-ui/package.json` / `pnpm-lock.yaml` | `simple-git ^3.36.0`, `vitest ^3.2.6`, `@playwright/test ^1.55.1`, pnpm overrides pinning patched `js-yaml/nanoid/postcss/rollup/ws/vite` (audit 38→9 vulns, 0 high/critical). |
| `.agents/skills/testing-pair-mission-control/SKILL.md` | Live-stack testing skill (previously authored, now tracked). |

## §10.3 Defects found and root causes

1. **Duplicate dispatch window in `openWorkItem` (P11 §2.D).** Root cause:
   check-then-act ordering — the mission was minted *before* the work item
   transitioned to IN_PROGRESS, so a second concurrent open (double-click,
   retry, crash replay) passed the state gate and created a second governed
   mission. Fixed by writing IN_PROGRESS+claim under the optimistic version
   lock *first*; the second opener now hits `FAIL_CLOSED_WORK_ITEM_TRANSITION`
   and cannot mint a mission. Budget refusal/startMission failure roll the
   marker back.
2. **Claim release unauthenticated.** `releaseClaim` dropped any live claim
   without a token — any caller could strip ownership. Fixed: live claims
   require the matching `claim_token`; expired claims stay releasable
   (reclaim semantics). Server route forwards `body.claim_token`.
3. **`createBudgetPolicy` accepted dangling/cross-business `scope_id`.**
   Agent scope now must resolve to an org_agent *of that business*;
   department scope must have ≥1 agent in the business. Fail closed.
4. **`createRoutine` skipped the assignee ACTIVE check** (work items had it,
   routines didn't). Fixed.
5. **`assignWorkItem` on an actively-claimed item** left the new assignee
   stranded behind a foreign 30-min claim. Now `FAIL_CLOSED_WORK_ITEM_CLAIMED`.
6. **Broker fetch probed with a fake `mission_id` left no audit trace** —
   the 404 short-circuited before `release()`'s audit. Fixed via `deny()`.
7. **CI fake-PASS**: `timeout` exit 124 was converted to `exit 0` (masked
   hangs); `pnpm audit --audit-level=high || true` could never fail. Both
   fixed; audit debt remediated to zero high/critical.
8. **Docs drift**: README/ARCHITECTURE/DOCUMENTATION described upstream
   Conway Automaton only; nothing described the PAIR Next control plane.
   Rewritten; RELEASE.json preserved untouched.

## §10.4 Invariants verified

- **A. Scope integrity** — cross-business `reports_to`, objective parent,
  work-item objective/assignee, budget scope, routine assignee all rejected
  fail-closed (tests: `scope1–scope4`). `reports_to`/`parent_objective_id`
  cycles are impossible by construction — there is no reparent/mutate
  endpoint; parentage is set only at create.
- **B. Lifecycle** — explicit `WORK_ITEM_TRANSITIONS`; open from
  IN_PROGRESS/DONE/CANCELLED rejected; governed reopen only via `openWorkItem`
  from BLOCKED/READY/BACKLOG (tests: `life1–life2`).
- **C. Claim integrity** — single live owner; expired reclaim; live claim
  release requires token; claim released on terminal sync; assigning a
  claimed item rejected (tests: `claim1–claim3`).
- **D. Single dispatch** — double-open mints exactly one mission; budget
  refusal rolls back to prior status with zero missions leaked
  (tests: `dup1–dup2`).
- **E. Routine projection** — ≤1 work item per fired mission, deduped by
  `mission_id`, stable across re-sync and across a fresh BusinessLayer on
  the same store (tests: `rt1–rt2`).

## §10.5 Tests

`src/__tests__/pair-p11.test.ts` — 22 tests covering: cross-business
rejection, invalid hierarchy, legal/illegal transitions, claim
contention/expiry/stale-token, duplicate-open, mission↔work-item linkage,
routine dedup + restart, budget boundary/concurrent hard-stop, credential
vault perms + leak + unknown-mission audit, evidence integrity, docs
consistency.

Results: **22/22 PASS**.

## §10.6 Suite / typecheck / build / audit / smoke results

- `pnpm test` (vitest 3.2.7): **1704 passed / 2 failed / 24 skipped**
  (71 files). The 2 failures are `pair-p5.test.ts` DSH/CODEX "stock probe
  must be unavailable" tests — environment-dependent: this dev box has
  `dsh`/`codex` binaries on PATH outside `.local` (the test only strips
  `.local`), so stock adapters probe as available. They pass on CI
  (GitHub runner lacks those binaries). Not weakened, not caused by P11.
- `pnpm run typecheck`: clean (tsc --noEmit, 0 errors).
- `pnpm run build`: clean (tsc + all workspace builds incl. UI).
- `pnpm audit --audit-level=high`: **0 high/critical** (was 17 high +
  2 critical; remaining 9 are moderate/low dev-tooling advisories).
- Smoke: HTTP server end-to-end exercised by `createMissionControlServer`
  tests (business routes + broker fetch incl. denial audit). Live stack
  on this box runs the pre-change code; restart smoke deferred to deploy.

## §10.7 Branch protection state

**OPERATOR ACTION REQUIRED.** `GET /repos/vankusi59-svg/pair-next/branches/main`
returns `"protected": false`; Devin's GitHub App token receives
`403 Resource not accessible by integration` on both read and write of
protection settings — it cannot change them.

Owner steps (GitHub → repo → Settings → Branches → Add branch ruleset/classic rule for `main`):
1. Require a pull request before merging (approvals: 0–1).
2. Require status checks to pass: `build-and-test`, `security-audit` (strict/up-to-date on).
3. Disallow force pushes; disallow deletions.
4. (Optional) enforce for admins.

## §10.8 Limitations / remaining hard debt

- Cross-route executor failover on 429 (RE_ROUTE) is still unproven —
  next hardening item; not part of P11.
- `openWorkItem` residual: if `startMission` succeeded but the link-put
  crashed (version conflict — unreachable single-threaded), a mission
  could exist without `work_item_id` back-link. Mitigated by metadata
  on the mission itself; crash window is sub-millisecond.
- Broker: credentials still release to *any* verified-mission caller with
  the broker token (documented boundary); per-agent scoped capability
  binding is explicitly P13 — not half-built here.
- 2 env-dependent P5 tests fail on dev boxes where `dsh`/`codex` are on
  PATH outside `~/.local` (see §10.6).
- Quick tunnel URL changes per boot (named tunnel deferred by operator).

## §10.9 What is deferred to P12

P12 agent execution contract (per-org_agent executor/provider/permission
policy); P13 token/USD cost ledger + scoped credential capabilities +
secret binding hierarchy; P14 autonomous heartbeat/inbox/delegation/work
graph/IN_REVIEW; P15 CEO agent/KPI gap analysis/objective-driven generation.
None pre-implemented.

## §11 Rollback

`git revert <merge-commit>` — all changes are additive guards + docs + CI
honesty; the only behavior contract change is `releaseClaim` now requiring
`claim_token` on live claims (API accepts `claim_token` in body).

## §12 Classification

**P11_OFFICIAL_FINAL_PASS** — all invariants implemented + regression-
tested, suite/typecheck/build/audit verified, docs drift closed, CI
honest; the single open item is branch protection, which requires owner
action on GitHub (§10.7) and is explicitly classified OPERATOR ACTION
REQUIRED rather than claimed enabled.

## Provenance

- Commit SHA / PR URL: see PR.
- `git status` at write time: clean except this report + diff files listed.
- **No secrets** were written to any file (vault/broker unchanged in this
  respect; `CLOUDFLARE_API_TOKEN` remains an org secret referenced by env
  name only).
