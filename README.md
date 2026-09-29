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

Dashboard auth: `Authorization: Bearer $PAIR_MC_TOKEN`; writes require `x-operator-id`.

## Docs

- `ARCHITECTURE.md` — current PAIR Next control-plane architecture
- `CURRENT_STATE.md` — what is on `main` since the V1.0.0 release
- `RELEASE.json` — V1.0.0 release manifest (frozen, historical)
- `DOCUMENTATION.md` — upstream Conway Automaton reference (the agent runtime this repo is built on)

## License

MIT
