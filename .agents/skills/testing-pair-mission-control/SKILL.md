---
name: testing-pair-mission-control
description: How to drive the PAIR Mission Control live stack (serve-mission-control.mjs + mission-control-ui SPA) for end-to-end UI/API testing — auth flow, operator id, mission issue paths, expected governed outcomes, and known API/UI field mismatches.
---

# Testing PAIR Mission Control (pair-next live stack)

## Stack & startup
- Server: `node scripts/serve-mission-control.mjs` (repo root, built `dist/` — run `pnpm build` first if stale). Port `PAIR_MC_PORT` (default 8788). Serves the built SPA from `apps/mission-control-ui/dist` (falls back to an inline legacy UI if `dist` is missing — check `PAIR Mission Control` page title + React DOM to know which UI you got).
- Env that changes behavior: `PAIR_MC_TOKEN` (auth), `PAIR_DSH_HOME`/`CODEX_HOME` (register DSH/CODEX executors even if they later probe UNQUALIFIED), `PAIR_DEVIN_API_KEY` (DEVIN qualification; remote dispatches burn real ACU — capped by `PAIR_MAX_REMOTE_TASKS_PER_DAY`, default 10), `PAIR_COST_HALT`/`COST_HALT` file (kill-switch).
- State dir `PAIR_MC_DIR`: `pair.db` persists across restarts — projects/missions survive; workspace is a `ws-*` dir under it.
- `scripts/start-pair-live.sh` brings up server + cloudflared tunnel + telegram bridge (bridge needs `PA Pair_TG_BOT_TOKEN`, absent = expected).

## Auth (UI)
- Every `/api/*` requires `Authorization: Bearer $PAIR_MC_TOKEN` (or `?token=` query for SSE).
- The SPA stores the token in `localStorage["pair.mc_token"]`. On **any** 401 it calls `window.prompt("Mission Control access token:")` and reloads on a non-null answer.
- **Gotcha:** the dashboard fires ~4 parallel API calls; each 401 queues its own `prompt()`. Expect to answer the same token prompt up to 4 times (filling each with the real token is harmless; Cancel skips that one). A `type` into the prompt may not land — click the input field first, type, then click OK.
- Fast path for automation: seed `localStorage["pair.mc_token"]` (and `pair.operator_id`, see below) via console/CDP before navigating, skipping the prompt entirely.

## Operator id
- POSTs (`/api/missions`, `/api/missions/preview`, actions) require operator identity: `x-operator-id` header or `operator_id` in body — otherwise the server rejects. The UI sends `x-operator-id` from `localStorage["pair.operator_id"]`, bound to the `#opid` input in the top-right header. Set it before submitting (e.g. `op:e2e`).

## API surface (common mistakes)
- There is **no** `/api/executors`. Executor status lives in `GET /api/routing` (`executors[]` + `routable[]` with gate detail and `reason_not_routable`). `GET /api/health` gives per-subsystem states. Other routes: `/api/missions`, `/api/missions/:id` (+`/dag`,`/timeline`,`/evidence`,`/files`), `/api/missions/preview` (POST, creates nothing), `/api/providers`, `/api/models`, `/api/routes`, `/api/approvals`, `/api/cost`, `/api/schedules`.
- Mission list items use `status`/`runtime_state` (not `state`). Executor `qualification_state` is nested at `descriptor.qualification.state` / `descriptor.metadata.qualification_state`, not top-level — several UI columns read the wrong path and show "—" (known bug, verify against API before trusting the rendered table).

## Mission issue flow & what "healthy" looks like
- `/missions/new`: goal textarea + project select + auto-confirm checkbox (default ON → one-click "Plan & run"; OFF → "Preview plan" review table + plan digest → "Confirm & run"). Server re-checks the plan digest on submit (two-step submit is fail-closed).
- Planner: if no LLM model route qualified at boot (`MODEL_ROUTE: skip ... (not discovered)` in logs), the plan expander no-ops and the **template planner** runs: T1 records the goal on PAIR_NATIVE (writes `mission_goal.txt`), T2 "llm analysis (dsh)" requiring `REASONING`, T3 codex step only if goal mentions code/script/python.
- If DSH is registered but UNQUALIFIED, T2 gets `ROUTING_DECISION_RECORDED → NO_ELIGIBLE_EXECUTOR` → recovery → mission stays `RUNNING` with T2 `READY` forever. That is correct fail-closed behavior, NOT a bug — assert the reason surfaces (mission timeline, Observability → Routing decisions tab) rather than expecting COMPLETED.
- PAIR_NATIVE runs locally and writes real artifacts into the mission workspace — verify `mission_goal.txt` both in the UI file viewer and on disk under the project `root_location`.
- DEVIN dispatches create real Devin sessions and spend ACU; avoid unless that's what you're testing (check `/api/cost` remote_dispatches_today first).

## Browser/tooling notes
- The box Chrome is Chrome for Testing: relaunch with `--remote-debugging-port=29229 --user-data-dir=/home/ubuntu/.browser_data_dir --no-sandbox`. Keep the same `user-data-dir` to preserve localStorage (token survives relaunch).
- `xdotool`-style typing drops Vietnamese diacritics (ả/ờ/ắ) — use unaccented goal text or paste.
- Screenshot-space coordinates shift when Chrome infobars (automation warning, `--no-sandbox` warning) close — re-screenshot after dismissing them before clicking.
