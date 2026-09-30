#!/usr/bin/env bash
# start-pair-live.sh — bring up the full PAIR Next live stack in one command:
# cloudflared tunnel -> mission-control server -> telegram bridge.
#
# Usage:
#   bash scripts/start-pair-live.sh            # start everything
#   PAIR_TG_BOT_TOKEN=xxx bash scripts/start-pair-live.sh
#
# Persistent state lives under PAIR_HOME (default: $HOME) — NEVER /tmp
# (tmp is wiped on restart; we lost state once already).
# Secrets are read from files/env at runtime — none are stored in the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAIR_HOME="${PAIR_HOME:-$HOME}"
MC_DIR="${PAIR_MC_DIR:-$PAIR_HOME/pair-mc-live}"
PORT="${PAIR_MC_PORT:-8788}"
LOG_DIR="${PAIR_LOG_DIR:-$PAIR_HOME/pair-logs}"
CF_BIN="${CLOUDFLARED_BIN:-$PAIR_HOME/cloudflared}"

mkdir -p "$MC_DIR" "$LOG_DIR"

echo "==> PAIR live start (root=$ROOT, home=$PAIR_HOME, dir=$MC_DIR)"

# --- 0. build check -----------------------------------------------------------
if [ ! -f "$ROOT/dist/index.js" ] && [ ! -d "$ROOT/dist" ]; then
  echo "==> dist/ missing — running pnpm build"
  (cd "$ROOT" && pnpm install && pnpm build)
fi

# --- 1. stop old stack --------------------------------------------------------
pkill -f "telegram-bridge.mjs" 2>/dev/null || true
OLD_PID=$(ss -tlnp 2>/dev/null | grep ":$PORT" | grep -oP 'pid=\K[0-9]+' | head -1 || true)
[ -n "${OLD_PID:-}" ] && kill -9 "$OLD_PID" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 1

# --- 2. cloudflared binary ----------------------------------------------------
if [ ! -x "$CF_BIN" ]; then
  echo "==> downloading cloudflared -> $CF_BIN"
  curl -sL -o "$CF_BIN" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
  chmod +x "$CF_BIN"
fi

# --- 3. tunnel ----------------------------------------------------------------
CF_LOG="$LOG_DIR/cloudflared.log"
nohup "$CF_BIN" tunnel --url "http://localhost:$PORT" > "$CF_LOG" 2>&1 &
echo "==> tunnel starting (log $CF_LOG)"
OUTBOX_URL=""
for _ in $(seq 1 30); do
  OUTBOX_URL=$(grep -o "https://[a-z-]*\.trycloudflare\.com" "$CF_LOG" | head -1 || true)
  [ -n "$OUTBOX_URL" ] && break
  sleep 1
done
[ -z "$OUTBOX_URL" ] && { echo "!! tunnel URL not found after 30s — check $CF_LOG"; exit 1; }
echo "==> tunnel: $OUTBOX_URL"

# --- 4. tokens (generated once, persisted) -------------------------------------
[ -f "$PAIR_HOME/pair-obx-token" ] || openssl rand -hex 16 > "$PAIR_HOME/pair-obx-token"
[ -f "$PAIR_HOME/pair-brk-token" ] || openssl rand -hex 16 > "$PAIR_HOME/pair-brk-token"
chmod 600 "$PAIR_HOME"/pair-*-token 2>/dev/null || true
OBX=$(cat "$PAIR_HOME/pair-obx-token")
BRK=$(cat "$PAIR_HOME/pair-brk-token")

# --- 5. mission-control server -------------------------------------------------
MC_LOG="$LOG_DIR/mc-serve.log"
(
  cd "$ROOT"
  PAIR_MC_DIR="$MC_DIR" \
  PAIR_DSH_HOME="${PAIR_DSH_HOME:-$HOME/.pair-dsh-home}" \
  CODEX_HOME="${CODEX_HOME:-$HOME/.codex}" \
  PAIR_MC_TOKEN="${PAIR_MC_TOKEN:-123}" \
  PAIR_MAX_REMOTE_TASKS_PER_DAY="${PAIR_MAX_REMOTE_TASKS_PER_DAY:-10}" \
  PAIR_OUTBOX_URL="$OUTBOX_URL" \
  PAIR_OUTBOX_TOKEN="$OBX" \
  PAIR_BROKER_TOKEN="$BRK" \
  PAIR_DSH_MODEL_ROUTE="${PAIR_DSH_MODEL_ROUTE:-nvidia:z-ai/glm-5.3-flash}" \
  PAIR_DSH_EXTRA_ROUTES="${PAIR_DSH_EXTRA_ROUTES:-groq:openai/gpt-oss-20b,gemini:gemini-3.1-flash-lite}" \
  PAIR_MODEL_PROBE_TIMEOUT_MS="${PAIR_MODEL_PROBE_TIMEOUT_MS:-30000}" \
  PAIR_LLM_PLANNER_TIMEOUT_MS="${PAIR_LLM_PLANNER_TIMEOUT_MS:-120000}" \
  nohup node scripts/serve-mission-control.mjs > "$MC_LOG" 2>&1 &
)
echo "==> server starting (log $MC_LOG)"
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/health" \
    -H "Authorization: Bearer ${PAIR_MC_TOKEN:-123}" || true)
  [ "$code" = "200" ] && break
  sleep 1
done
[ "${code:-000}" = "200" ] && echo "==> server UP  http://localhost:$PORT" \
  || { echo "!! server not healthy after 30s — check $MC_LOG"; exit 1; }

# --- 6. telegram bridge --------------------------------------------------------
TG_TOKEN="${PAIR_TG_BOT_TOKEN:-}"
[ -z "$TG_TOKEN" ] && [ -f "$PAIR_HOME/pair-tg-token" ] && TG_TOKEN=$(cat "$PAIR_HOME/pair-tg-token")
ALLOW_FILE="$MC_DIR/telegram-allow.json"
if [ ! -f "$ALLOW_FILE" ]; then
  if [ -n "${PAIR_TG_CHAT_ID:-}" ]; then
    printf '["%s"]\n' "$PAIR_TG_CHAT_ID" > "$ALLOW_FILE"
    echo "==> allowlist created for chat $PAIR_TG_CHAT_ID"
  else
    echo "[]" > "$ALLOW_FILE"
    echo "!! allowlist empty — bridge runs in fail-closed discovery mode;"
    echo "!! add your chat_id to $ALLOW_FILE (send /id to the bot once allowlisted)"
  fi
fi
if [ -z "$TG_TOKEN" ]; then
  echo "!! PAIR_TG_BOT_TOKEN missing — bridge NOT started."
  echo "   Set env PAIR_TG_BOT_TOKEN or write it to $PAIR_HOME/pair-tg-token then:"
  echo "   PAIR_TG_BOT_TOKEN=... PAIR_MC_URL=http://localhost:$PORT \\"
  echo "     PAIR_MC_TOKEN=${PAIR_MC_TOKEN:-123} PAIR_MC_DIR=$MC_DIR \\"
  echo "     node scripts/telegram-bridge.mjs &"
else
  TG_LOG="$LOG_DIR/pair-tg.log"
  (
    cd "$ROOT"
    PAIR_TG_BOT_TOKEN="$TG_TOKEN" \
    PAIR_MC_URL="http://localhost:$PORT" \
    PAIR_MC_TOKEN="${PAIR_MC_TOKEN:-123}" \
    PAIR_MC_DIR="$MC_DIR" \
    PAIR_TG_ALLOW_FILE="$ALLOW_FILE" \
    nohup node scripts/telegram-bridge.mjs > "$TG_LOG" 2>&1 &
  )
  sleep 3
  grep -q "telegram-bridge: bot" "$TG_LOG" && echo "==> bridge UP  $(head -1 "$TG_LOG")" \
    || echo "!! bridge may have failed — check $TG_LOG"
fi

echo ""
echo "DONE. Server http://localhost:$PORT | tunnel $OUTBOX_URL | logs $LOG_DIR"
