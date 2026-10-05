#!/usr/bin/env bash
# pair-bootstrap.sh — one-command provisioner for a fresh PAIR Next host.
#
# Idempotent: every step checks first, installs only what's missing/wrong.
# Usage:
#   bash scripts/pair-bootstrap.sh           # install everything missing
#   bash scripts/pair-bootstrap.sh --check   # report only, change nothing
#
# What it installs: node (via nvm), pnpm (corepack), repo deps + dist build,
# codex CLI, dsh executor (+ gemini compat patch + settings.yaml), cloudflared,
# pair-mc-live scaffold (telegram-allow.json template).
#
# What it CANNOT install (prints a checklist at the end): secrets —
# PAIR_TG_BOT_TOKEN / ~/pair-tg-token, provider API keys (NVIDIA_API_KEY,
# GROQ_API_KEY, CLOUDFLARE_API_TOKEN, GEMINI_API_KEY), codex auth (~/.codex).

set -uo pipefail

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

PAIR_HOME="${PAIR_HOME:-$HOME}"
MC_DIR="${PAIR_MC_DIR:-$PAIR_HOME/pair-mc-live}"
DSH_HOME="${PAIR_DSH_HOME:-$HOME/.pair-dsh-home}"
NODE_WANT_MAJOR=22
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OK=(); MISS=(); ACT=()
note()  { echo "  $*"; }
have()  { OK+=("$1"); note "[ok]   $1"; }
need()  { MISS+=("$1"); note "[MISS] $1"; }
acted() { ACT+=("$1"); note "[did]  $1"; }

run()   { [ "$CHECK_ONLY" = "1" ] && return 0; "$@"; }

# --- node -------------------------------------------------------------------
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -d "$NVM_DIR/versions/node" ]; then
  NODE_BIN="$(ls -d "$NVM_DIR"/versions/node/v${NODE_WANT_MAJOR}*/bin/node 2>/dev/null | sort -V | tail -1)"
fi

NODE_MAJOR="0"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] && NODE_MAJOR="$("$NODE_BIN" -v | sed 's/^v//;s/\..*//')"

if [ "$NODE_MAJOR" -ge 20 ]; then
  have "node $("$NODE_BIN" -v) ($NODE_BIN)"
  export PATH="$(dirname "$NODE_BIN"):$PATH"
else
  need "node >= 20 (want v$NODE_WANT_MAJOR via nvm)"
  if [ "$CHECK_ONLY" = "0" ]; then
    [ -f "$NVM_DIR/nvm.sh" ] || {
      note "installing nvm..."
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    }
    . "$NVM_DIR/nvm.sh"
    nvm install "$NODE_WANT_MAJOR" >/dev/null
    nvm alias default "$NODE_WANT_MAJOR" >/dev/null
    export PATH="$NVM_DIR/versions/node/v$("$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm version "$NODE_WANT_MAJOR" | tr -d 'v')/bin:$PATH"
    NODE_BIN="$(ls -d "$NVM_DIR"/versions/node/v${NODE_WANT_MAJOR}*/bin/node | sort -V | tail -1)"
    export PATH="$(dirname "$NODE_BIN"):$PATH"
    acted "node $(node -v) via nvm"
  fi
fi

# --- pnpm -------------------------------------------------------------------
if command -v pnpm >/dev/null 2>&1; then
  have "pnpm $(pnpm -v)"
else
  need "pnpm"
  if [ "$CHECK_ONLY" = "0" ]; then
    if command -v corepack >/dev/null 2>&1; then
      corepack enable >/dev/null 2>&1 || true
      corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
    fi
    command -v pnpm >/dev/null 2>&1 || npm install -g pnpm >/dev/null
    acted "pnpm $(pnpm -v 2>/dev/null || echo '?')"
  fi
fi

# --- repo deps + build --------------------------------------------------------
if [ -d "$ROOT/node_modules" ] && [ -d "$ROOT/dist" ]; then
  have "repo deps + dist/ build ($ROOT)"
else
  need "pnpm install + build in $ROOT"
  if [ "$CHECK_ONLY" = "0" ] && command -v pnpm >/dev/null 2>&1; then
    (cd "$ROOT" && pnpm install && pnpm build) && acted "pnpm install + build"
  fi
fi

# --- codex CLI -----------------------------------------------------------------
if command -v codex >/dev/null 2>&1; then
  have "codex $(codex --version 2>/dev/null | head -1)"
else
  need "codex CLI (@openai/codex)"
  run npm install -g @openai/codex >/dev/null && acted "codex CLI via npm -g"
fi
if [ -f "$HOME/.codex/auth.json" ]; then
  have "codex auth (~/.codex/auth.json)"
else
  MISS+=("codex auth — run 'codex login' once (ChatGPT account or API key)")
  note "[MISS] codex auth — run 'codex login' once"
fi

# --- dsh executor ---------------------------------------------------------------
NPM_ROOT_G="$(npm root -g 2>/dev/null || true)"
if command -v dsh >/dev/null 2>&1 || [ -n "$NPM_ROOT_G" ] && [ -d "$NPM_ROOT_G/@deepseek-ai/dsh" ]; then
  have "dsh executor (@deepseek-ai/dsh)"
else
  need "dsh executor (@deepseek-ai/dsh)"
  run npm install -g @deepseek-ai/dsh >/dev/null && acted "dsh via npm -g"
  NPM_ROOT_G="$(npm root -g 2>/dev/null || true)"
fi

# gemini compat patch (re-run safe: exits 0 'already patched')
# dsh may live under nvm's global node_modules — point the patcher at npm root -g.
if [ -f "$ROOT/scripts/dsh-gemini-compat.sh" ] && [ -n "$NPM_ROOT_G" ]; then
  if [ "$CHECK_ONLY" = "0" ]; then
    out="$(env DSH_PI_AI_PATH="$NPM_ROOT_G" bash "$ROOT/scripts/dsh-gemini-compat.sh" 2>&1 || true)"
    case "$out" in
      *"already patched"*|*"patched"*) acted "dsh gemini compat patch ($out)" ;;
      *) note "  !! gemini compat patch: $out" ;;
    esac
  else
    have "dsh gemini compat patch (re-applied on install)"
  fi
fi

# dsh settings.yaml
if [ -f "$DSH_HOME/settings.yaml" ]; then
  have "dsh settings.yaml ($DSH_HOME)"
else
  need "dsh settings.yaml"
  if [ "$CHECK_ONLY" = "0" ]; then
    mkdir -p "$DSH_HOME"
    cp "$ROOT/scripts/pair-dsh-settings.example.yaml" "$DSH_HOME/settings.yaml" \
      && acted "settings.yaml <- repo template (edit providers/models as needed)"
  fi
fi

# --- cloudflared ------------------------------------------------------------------
CF_BIN="${CLOUDFLARED_BIN:-$PAIR_HOME/cloudflared}"
if command -v cloudflared >/dev/null 2>&1 || [ -x "$CF_BIN" ]; then
  have "cloudflared"
else
  need "cloudflared"
  if [ "$CHECK_ONLY" = "0" ]; then
    curl -fsSL -o "$CF_BIN" \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" \
      && chmod +x "$CF_BIN" && acted "cloudflared -> $CF_BIN"
  fi
fi

# --- live dir scaffold --------------------------------------------------------------
[ -d "$MC_DIR" ] || { need "$MC_DIR"; run mkdir -p "$MC_DIR" && acted "mkdir $MC_DIR"; }
ALLOW_FILE="$MC_DIR/telegram-allow.json"
if [ -f "$ALLOW_FILE" ]; then
  have "telegram-allow.json"
else
  need "telegram-allow.json (chat allowlist)"
  run printf '["%s"]\n' "${PAIR_TG_CHAT_ID:-PUT_YOUR_TELEGRAM_CHAT_ID}" > "$ALLOW_FILE" \
    && acted "telegram-allow.json scaffold — set PAIR_TG_CHAT_ID or edit it"
fi

# --- secrets checklist (never print values) -------------------------------------------
echo
echo "==> secrets checklist (configured = present, value never shown)"
sec_env() { # name, file fallback
  local name="$1" file="${2:-}"
  if [ -n "${!name:-}" ]; then echo "  [ok]   $name (env)";
  elif [ -n "$file" ] && [ -f "$file" ]; then echo "  [ok]   $name ($file)";
  else echo "  [MISS] $name — set env or write $file"; MISS+=("$name"); fi
}
sec_env PAIR_TG_BOT_TOKEN "$PAIR_HOME/pair-tg-token"
for k in NVIDIA_API_KEY GROQ_API_KEY CLOUDFLARE_API_TOKEN GEMINI_API_KEY; do
  sec_env "$k" ""
done
[ -f "$PAIR_HOME/pair-mc-token" ] && echo "  [ok]   MC token file" \
  || echo "  [info] MC token — auto-generated by start-pair-live.sh"

echo
echo "==> summary: ${#OK[@]} ok, ${#ACT[@]} installed/changed, ${#MISS[@]} missing"
if [ "${#MISS[@]}" -gt 0 ]; then
  echo "    next: provide the [MISS] items above, then rerun this script."
fi
echo "    then: PAIR_TG_BOT_TOKEN=... bash scripts/start-pair-live.sh"
[ "${#MISS[@]}" -eq 0 ]
