# PAIR OS vNext — Deploy on your own machine

Requirements: Node.js v22+, pnpm 10, git. (Python 3 for the dsh patch step.)

## 1. Install & build

```bash
git clone https://github.com/vankusi59-svg/pair-next.git
cd pair-next
pnpm install --frozen-lockfile
pnpm build
```

## 2. Run Mission Control (UI + API)

```bash
node scripts/serve-mission-control.mjs
# → http://localhost:8788
```

Runs immediately with the **PAIR_NATIVE** executor (in-process file ops) and
the LLM planner *if* a model provider is configured (below). Without any
executor credentials you still get the full governed UI, but plan T2/T3 LLM
steps and the LLM planner itself are absent → missions fall back to the
minimal template plan.

## 3. Enable the Gemini LLM executor (DSH)

```bash
npm i -g @deepseek-ai/dsh          # installs dsh CLI
export PAIR_DSH_HOME=$HOME/.pair-dsh-home
mkdir -p "$PAIR_DSH_HOME"
export GEMINI_API_KEY=<your key>
```

Create `$PAIR_DSH_HOME/settings.yaml` (provider + models; `supportsStore: false`
is required — Gemini's OpenAI-compat endpoint rejects the `store` field):

```yaml
llm-pi-ai:
  providers:
    gemini:
      displayName: Gemini
      apiKeyEnv: GEMINI_API_KEY
      api: openai-completions
      baseURL: https://generativelanguage.googleapis.com/v1beta/openai
      models:
        - id: gemini-3.1-flash-lite
          compat:
            supportsStore: false
```

Patch the vendored pi-ai for Gemini `thought_signature` (Gemini 3 requires
round-tripping it on tool calls; a `npm` reinstall of dsh reverts the patch,
re-run then):

```bash
bash scripts/dsh-gemini-compat.sh
```

Then start with `PAIR_DSH_HOME` set:

```bash
PAIR_DSH_HOME=$HOME/.pair-dsh-home node scripts/serve-mission-control.mjs
```

Boot log should show `MODEL_ROUTE: gemini:gemini-3.1-flash-lite QUALIFIED`.

### Optional: Groq fallback route

Add a `groq` provider block to the same settings.yaml
(`apiKeyEnv: GROQ_API_KEY`, `baseURL: https://api.groq.com/openai/v1`,
model `openai/gpt-oss-20b`), export `GROQ_API_KEY`, restart. The boot log
will report it `QUALIFIED` and it appears on the Providers page as a
routable fallback.

### Optional: Codex executor

Install `@openai/codex` CLI, log in (`codex login` → ChatGPT OAuth), export
`CODEX_HOME=$HOME/.codex`. The router will then also route `PYTHON_EXECUTION`
tasks to Codex.

## 4. Verify

1. Open `http://localhost:8788`, set an **operator id** (top-right, e.g. `op:me`).
2. **New Mission** → type a goal → **Plan & run** (auto-confirm is ON by
   default; untick to review the LLM plan first).
3. Dashboard/Mission Detail show tasks routed to PAIR_NATIVE + DEEPSEEK_HARNESS
   and artifacts written into the mission workspace.

## Env reference

| Var | Meaning | Default |
|---|---|---|
| `PAIR_MC_PORT` | server port | `8788` |
| `PAIR_MC_DIR` | data dir (db, journal, workspaces) | `./.pair-mc` |
| `PAIR_DSH_HOME` | dsh settings dir (enables DSH executor) | unset |
| `CODEX_HOME` | codex dir (enables Codex executor) | unset |
| `PAIR_DSH_MODEL_ROUTE` | primary `provider:model` | `gemini:gemini-3.1-flash-lite` |
| `PAIR_DSH_FALLBACK_ROUTE` | secondary route to qualify | `groq:openai/gpt-oss-20b` |
| `PAIR_MC_UI_DIR` | built UI dir | `apps/mission-control-ui/dist` |
| `GEMINI_API_KEY` / `GROQ_API_KEY` | provider credentials | unset |
| `PAIR_DEVIN_API_KEY` | Devin API key (`cog_...`) — enables the DEVIN executor (REMOTE_CLOUD_TASK_EXECUTION). Unset = registered but UNQUALIFIED | unset |
| `PAIR_DEVIN_ORG_ID` | Devin org id for session dispatch | built-in default |

Never commit real keys — reference env vars only.
