# PAIR Next

Governed mission control plane for a one-person, always-on business — built on the Conway Automaton agent codebase.

PAIR Next keeps the automaton runtime (agent loop, tools, sandbox, memory) but wraps it in a **governed control plane**: every piece of work flows as `Business Layer → Work Item → MissionControl → Canonical Mission → Planner → MissionRouter → GovernedTaskGate → Executor → Recovery → Verified Experience → Result`. Business entities never dispatch side effects directly.

## Release status

- **Official release:** `v1.0.0-pair-next-official-final` — see `RELEASE.json` (V1 manifest, frozen historical record).
- **Current `main`:** post-V1 development — Business Layer (org agents, work items, objectives, routines, budgets), verified-experience learning loop, live governed stack (`scripts/serve-mission-control.mjs` + Telegram bridge + React Mission Control UI). See `CURRENT_STATE.md`.

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm run build        # tsc + workspace builds (Node 22)
pnpm test             # full deterministic suite
```

### Live governed stack

```bash
scripts/start-pair-live.sh   # builds, starts server :8788, tunnel, telegram bridge
```

The serve script (`scripts/serve-mission-control.mjs`) wires the full stack: evidence store, governed gate, executor registry, mission router, planner (multi-provider DSH model routes: `PAIR_DSH_MODEL_ROUTE`, `PAIR_DSH_FALLBACK_ROUTE`, `PAIR_DSH_EXTRA_ROUTES`), business layer, credential broker, experience service.

**Phase A — runtime timeouts** (validated at startup, fail closed on malformed input): `PAIR_MODEL_PROBE_TIMEOUT_MS` (default 8000, bounds 500–120000), `PAIR_LLM_PLANNER_TIMEOUT_MS` (default 20000, bounds 2000–900000), `PAIR_TASK_TIMEOUT_S` (default 120s per governed task, bounds 5–7200; a task's own `metadata.timeout` still wins).

**Phase A — canonical model roles.** Models are assigned roles in the canonical store (`model_role_assignment`, keyed by `model_entry_id`): `PLANNER_COORDINATOR` via `PAIR_PLANNER_MODEL_ROUTE` (default `gemini:gemini-3.1-flash-lite`), `DSH_EXECUTION` via the `PAIR_DSH_*_ROUTE*` vars (defaults `cloudflare:@cf/zai-org/glm-4.7-flash`, `groq:openai/gpt-oss-20b`). Every configured route must resolve to a catalog `model_entry` at boot — an unresolved or malformed route fails closed (`FAIL_CLOSED_MODEL_ROLE_ROUTE_UNRESOLVED`) before any role mutation; two routes resolving to one entry collapse to that model. Boot-time `reconcileModelRoleAssignments` (one atomic transaction) converges ACTIVE assignments to the configured pools: stale → `MODEL_ROLE_REVOKED` (role=null, audited), changed → `MODEL_ROLE_REASSIGNED`, identical → no-op. Hard invariant: the same canonical model (incl. proven aliases) may not sit in both pools — startup fails closed (`FAIL_CLOSED_MODEL_ROLE_OVERLAP`) on configured AND stored state, and runtime asserts the role at each planner call and each DSH session pin.

Dashboard auth: `Authorization: Bearer $PAIR_MC_TOKEN`; writes require `x-operator-id`. Token resolution (shared by server + telegram bridge): explicit `PAIR_MC_TOKEN` → `$PAIR_HOME/pair-mc-token` (chmod 600) → generated 256-bit random persisted there. No static default ever ships; to inspect it locally read the file (`cat ~/pair-mc-token`) — it is never logged.

**Devin API:** set `PAIR_DEVIN_API_KEY` to a service-user or personal-access `cog_` credential to use API v3. Set `PAIR_DEVIN_ORG_ID` when choosing an organization explicitly (required for enterprise service users whose `/v3/self` has no org). Otherwise the adapter resolves the credential's organization via `/v3/self`. Sessions and separately paginated messages use `/v3/organizations/{org_id}/sessions`; the organization and API version are pinned in each execution journal. Legacy `apk_`/`apk_user_` keys and historic v1 execution journals retain API v1. `PAIR_DEVIN_MODE` applies only to legacy v1; v3 uses its documented default mode. See [Devin authentication](https://docs.devin.ai/api-reference/authentication).

## Docs

- `ARCHITECTURE.md` — current PAIR Next control-plane architecture
- `CURRENT_STATE.md` — what is on `main` since the V1.0.0 release
- `RELEASE.json` — V1.0.0 release manifest (frozen, historical)
- `DOCUMENTATION.md` — upstream Conway Automaton reference (the agent runtime this repo is built on)

## License

MIT
