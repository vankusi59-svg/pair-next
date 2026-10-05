#!/usr/bin/env bash
# pair-bootstrap.sh — one-command provisioner for a fresh PAIR Next host.
#
# Idempotent: every step checks first, installs only what's missing/wrong.
# Usage:
#   bash scripts/pair-bootstrap.sh           # install everything missing
#   bash scripts/pair-bootstrap.sh --check   # read-only report (zero mutation)
#
# Installs: node (via nvm), pnpm (version pinned from package.json
# packageManager), repo deps + dist build, codex CLI, @deepseek-ai/dsh
# (version pinned to the compat-patch-verified release) + gemini compat patch
# + settings.yaml, cloudflared, pair-mc-live scaffold.
#
# Never installs or prints secrets — ends with a configured/missing checklist.
# Exit code: 0 iff the final-state check finds nothing missing.

set -uo pipefail

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

PAIR_HOME="${PAIR_HOME:-$HOME}"
MC_DIR="${PAIR_MC_DIR:-$PAIR_HOME/pair-mc-live}"
DSH_HOME="${PAIR_DSH_HOME:-$HOME/.pair-dsh-home}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
NODE_WANT_MAJOR=22
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Pinned versions (reproducibility).
# pnpm: canonical version is the repo's packageManager field — derive it so a
#   repo bump follows automatically; never floating pnpm@latest.
PNPM_WANT="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9.]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
PNPM_WANT="${PNPM_WANT:-10.28.1}"
# dsh: pinned to the release verified compatible with dsh-gemini-compat.sh
#   anchors (0.2.0-rc.2). A blind `latest` install could ship pi-ai source the
#   patcher cannot patch — that must fail closed, not silently pass.
DSH_WANT="0.2.0-rc.2"
# codex + cloudflared intentionally track latest: no PAIR compat layer depends
#   on their internals — codex is probed by version/transport at boot and the
#   planner only needs a working binary; cloudflared is a protocol-stable
#   tunnel binary. Pinning them adds maintenance with no correctness gain.

note()  { echo "  $*"; }
have()  { note "[ok]   $1"; }
need()  { note "[MISS] $1"; }
acted() { note "[did]  $1"; }

npm_root() { npm root -g 2>/dev/null; }
pi_ai_file() {
  local r; r="$(npm_root)"
  [ -n "$r" ] && printf '%s' "$r/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"
}
dsh_pkg_dir() { local r; r="$(npm_root)"; [ -n "$r" ] && printf '%s' "$r/@deepseek-ai/dsh"; }
dsh_pkg_present() { local d; d="$(dsh_pkg_dir)"; [ -n "$d" ] && [ -d "$d" ]; }
dsh_bin_path() { command -v dsh 2>/dev/null; }
# the binary PAIR will actually invoke must resolve INSIDE the pinned npm
# package — a foreign `dsh` shadowing on PATH is a split-brain install.
dsh_bin_real() { local b; b="$(dsh_bin_path)"; [ -n "$b" ] && realpath "$b" 2>/dev/null; }
dsh_bound() {
  local d b; d="$(dsh_pkg_dir)"; b="$(dsh_bin_real)"
  [ -n "$d" ] && [ -n "$b" ] || return 1
  case "$b" in "$d"/*) return 0;; esac
  return 1
}
dsh_version() {
  local r; r="$(npm_root)"
  [ -n "$r" ] && sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$r/@deepseek-ai/dsh/package.json" 2>/dev/null | head -1
}
patch_marker_present() {
  local f; f="$(pi_ai_file)"
  [ -n "$f" ] && [ -f "$f" ] && grep -q 'geminiThoughtSignature' "$f"
}
allow_file_ready() {
  local f="$MC_DIR/telegram-allow.json"
  [ -f "$f" ] || return 1
  # bridge contract (telegram-bridge.mjs allowedChats): JSON array -> Set(String),
  # incoming id compared via String(chatId). ready = at least one entry whose
  # String() representation IS the canonical Telegram chat-id the bridge will
  # match: -?[1-9]\d*  (no whitespace, no leading zeros, no 0/-0). Negative
  # group/channel ids (-100…) are valid. JSON numeric entries must be safe
  # integers — Node String(>2^53) would print an imprecise decimal.
  python3 - "$f" <<'PY' >/dev/null 2>&1
import json,re,sys
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
if not isinstance(d,list): sys.exit(1)
MAX_SAFE=2**53-1
def ok(x):
    if isinstance(x,bool): return False
    if isinstance(x,int):
        if x==0 or abs(x)>MAX_SAFE: return False
        s=str(x)
    elif isinstance(x,str):
        s=x  # no strip: " 123 " is not the canonical id String(chatId) produces
    else: return False
    if "PUT_YOUR" in s: return False
    return re.fullmatch(r"-?[1-9]\d*", s) is not None
if not any(ok(x) for x in d): sys.exit(1)
PY
}
token_ready() {
  [ -n "${PAIR_TG_BOT_TOKEN:-}" ] && return 0
  [ -s "$PAIR_HOME/pair-tg-token" ]
}

# --- node -------------------------------------------------------------------
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -d "$NVM_DIR/versions/node" ]; then
  NODE_BIN="$(ls -d "$NVM_DIR"/versions/node/v${NODE_WANT_MAJOR}*/bin/node 2>/dev/null | sort -V | tail -1)"
fi

NODE_MAJOR=0
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] && NODE_MAJOR="$("$NODE_BIN" -v | sed 's/^v//;s/\..*//')"

if [ "$NODE_MAJOR" -ge 20 ]; then
  have "node $("$NODE_BIN" -v) ($NODE_BIN)"
  export PATH="$(dirname "$NODE_BIN"):$PATH"
else
  if [ "$CHECK_ONLY" = "1" ]; then
    need "node >= 20 (want v$NODE_WANT_MAJOR via nvm)"
  else
    [ -f "$NVM_DIR/nvm.sh" ] || {
      note "installing nvm..."
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    }
    . "$NVM_DIR/nvm.sh"
    nvm install "$NODE_WANT_MAJOR" >/dev/null
    nvm alias default "$NODE_WANT_MAJOR" >/dev/null
    NODE_BIN="$(ls -d "$NVM_DIR"/versions/node/v${NODE_WANT_MAJOR}*/bin/node | sort -V | tail -1)"
    export PATH="$(dirname "$NODE_BIN"):$PATH"
    acted "node $(node -v) via nvm"
  fi
fi

# --- pnpm (pinned to repo packageManager) -------------------------------------
# measure pnpm in repo context: the corepack shim serves packageManager's pin there.
PNPM_HAVE="$(cd "$ROOT" && pnpm -v 2>/dev/null || true)"
if [ "$PNPM_HAVE" = "$PNPM_WANT" ]; then
  have "pnpm $PNPM_HAVE"
else
  need "pnpm@$PNPM_WANT${PNPM_HAVE:+ (have $PNPM_HAVE)}"
  if [ "$CHECK_ONLY" = "0" ]; then
    if command -v corepack >/dev/null 2>&1; then
      corepack enable >/dev/null 2>&1 || true
      corepack prepare "pnpm@$PNPM_WANT" --activate >/dev/null 2>&1 || true
    fi
    [ "$(cd "$ROOT" && pnpm -v 2>/dev/null)" = "$PNPM_WANT" ] || npm install -g "pnpm@$PNPM_WANT" >/dev/null
    acted "pnpm $(cd "$ROOT" && pnpm -v 2>/dev/null || echo 'FAILED')"
  fi
fi

# --- repo deps + build ---------------------------------------------------------
if [ -d "$ROOT/node_modules" ] && [ -d "$ROOT/dist" ]; then
  have "repo deps + dist/ build ($ROOT)"
else
  need "pnpm install + build in $ROOT"
  if [ "$CHECK_ONLY" = "0" ]; then
    (cd "$ROOT" && pnpm install && pnpm build) && acted "pnpm install + build"
  fi
fi

# --- codex CLI (latest — nothing in PAIR depends on codex internals) -------------
if command -v codex >/dev/null 2>&1; then
  have "codex $(codex --version 2>/dev/null | head -1)"
else
  need "codex CLI (@openai/codex)"
  if [ "$CHECK_ONLY" = "0" ]; then
    npm install -g @openai/codex >/dev/null && acted "codex CLI via npm -g"
  fi
fi

# --- dsh executor (pinned) -------------------------------------------------------
NPM_ROOT_G="$(npm_root)"
DSH_HAVE="$(dsh_version)"
if dsh_bound && [ "$DSH_HAVE" = "$DSH_WANT" ]; then
  have "dsh executor $DSH_HAVE ($(dsh_bin_path))"
else
  if [ -n "$(dsh_bin_path)" ] && ! dsh_bound; then
    need "dsh PATH binary resolves outside pinned package (split-brain: $(dsh_bin_real) vs $(dsh_pkg_dir))"
  elif [ -z "$(dsh_bin_path)" ] && dsh_pkg_present; then
    need "dsh binary not on PATH (pinned package present at $(dsh_pkg_dir))"
  else
    need "dsh executor @deepseek-ai/dsh@$DSH_WANT${DSH_HAVE:+ (have $DSH_HAVE)}"
  fi
  if [ "$CHECK_ONLY" = "0" ]; then
    npm install -g "@deepseek-ai/dsh@$DSH_WANT" >/dev/null
    NPM_ROOT_G="$(npm_root)"
    acted "dsh via npm -g ($(dsh_version)) — PATH binding re-checked in final state"
  fi
fi

# --- dsh gemini compat patch (fail-closed, marker-verified) -----------------------
if dsh_pkg_present; then
  if [ "$CHECK_ONLY" = "1" ]; then
    if patch_marker_present; then
      have "dsh gemini compat patch (marker verified)"
    else
      need "dsh gemini compat patch (unpatched at $(pi_ai_file))"
    fi
  else
    # no || true — patcher failure must propagate to the final check.
    if env DSH_PI_AI_PATH="$(npm_root)" bash "$ROOT/scripts/dsh-gemini-compat.sh" \
       && patch_marker_present; then
      acted "dsh gemini compat patch verified"
    else
      need "dsh gemini compat patch FAILED — dsh unusable until fixed"
    fi
  fi
fi

# --- dsh settings.yaml (+ .imported restore, same as start-pair-live.sh) ---------
DSH_SETTINGS="$DSH_HOME/settings.yaml"
if [ -f "$DSH_SETTINGS" ]; then
  have "dsh settings.yaml ($DSH_HOME)"
elif [ -f "$DSH_SETTINGS.imported" ]; then
  # dsh renames settings.yaml -> settings.yaml.imported after importing it once;
  # never seed the template over it — restore the imported semantic config.
  need "dsh settings.yaml (settings.yaml.imported present — install mode restores it)"
  if [ "$CHECK_ONLY" = "0" ]; then
    cp "$DSH_SETTINGS.imported" "$DSH_SETTINGS" && acted "settings.yaml restored from .imported"
  fi
else
  need "dsh settings.yaml"
  if [ "$CHECK_ONLY" = "0" ]; then
    mkdir -p "$DSH_HOME"
    cp "$ROOT/scripts/pair-dsh-settings.example.yaml" "$DSH_SETTINGS" \
      && acted "settings.yaml <- repo template"
  fi
fi

# --- cloudflared (latest — protocol-stable tunnel binary) -------------------------
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
if [ -d "$MC_DIR" ]; then
  have "$MC_DIR"
else
  need "$MC_DIR"
  if [ "$CHECK_ONLY" = "0" ]; then
    mkdir -p "$MC_DIR" && acted "mkdir $MC_DIR"
  fi
fi
if allow_file_ready; then
  have "telegram-allow.json (valid, configured)"
else
  if [ "$CHECK_ONLY" = "1" ]; then
    need "telegram-allow.json (missing / unparseable / placeholder)"
  else
    [ -f "$MC_DIR/telegram-allow.json" ] \
      || printf '["%s"]\n' "${PAIR_TG_CHAT_ID:-PUT_YOUR_TELEGRAM_CHAT_ID}" > "$MC_DIR/telegram-allow.json"
    if allow_file_ready; then
      acted "telegram-allow.json configured"
    else
      need "telegram-allow.json — set PAIR_TG_CHAT_ID or edit $MC_DIR/telegram-allow.json"
    fi
  fi
fi

# === final state — authoritative summary + exit code ==============================
# Recomputed from disk AFTER all install steps: a component that was installed
# successfully reports [ok] here; nothing installed remains a stale MISS.
echo
echo "==> final state"
FMISS=()
freq() { # freq "label" test...
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  [ok]   $label"; else echo "  [MISS] $label"; FMISS+=("$label"); fi
}
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/^v//;s/\..*//')" -ge 20 ]; }
pnpm_ok() { [ "$(cd "$ROOT" && pnpm -v 2>/dev/null)" = "$PNPM_WANT" ]; }
dsh_ok()  { dsh_bound && [ "$(dsh_version)" = "$DSH_WANT" ]; }
patch_ok() { ! dsh_pkg_present || patch_marker_present; }
codex_auth_ok() { [ -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]; }
env_set() { [ -n "${!1:-}" ]; }

freq "node >= 20" node_ok
freq "pnpm@$PNPM_WANT" pnpm_ok
repo_built() { [ -d "$ROOT/node_modules" ] && [ -d "$ROOT/dist" ]; }
freq "repo build (node_modules + dist)" repo_built
freq "codex CLI" command -v codex
freq "codex auth ($CODEX_HOME/auth.json — 'codex login' once)" codex_auth_ok
freq "dsh @deepseek-ai/dsh@$DSH_WANT" dsh_ok
freq "dsh gemini compat patch" patch_ok
freq "dsh settings.yaml" test -f "$DSH_SETTINGS"
cf_ok() { command -v cloudflared >/dev/null 2>&1 || [ -x "$CF_BIN" ]; }
freq "cloudflared" cf_ok
freq "telegram-allow.json configured" allow_file_ready

echo "  -- required secrets (default live stack; values never shown)"
freq "PAIR_TG_BOT_TOKEN or ~/pair-tg-token (non-empty)" token_ready
for k in GROQ_API_KEY CLOUDFLARE_API_TOKEN GEMINI_API_KEY; do
  freq "$k (env)" env_set "$k"
done
if env_set NVIDIA_API_KEY; then
  echo "  [ok]   NVIDIA_API_KEY (optional — no default route uses it)"
else
  echo "  [info] NVIDIA_API_KEY unset — optional (no default route uses it)"
fi
[ -f "$PAIR_HOME/pair-mc-token" ] && echo "  [ok]   MC token file" \
  || echo "  [info] MC token — auto-generated by start-pair-live.sh"

echo
echo "==> summary: ${#FMISS[@]} still missing"
if [ "${#FMISS[@]}" -gt 0 ]; then
  echo "    next: fix the [MISS] items above, then rerun this script."
else
  echo "    ready: PAIR_TG_BOT_TOKEN=... bash scripts/start-pair-live.sh"
fi
[ "${#FMISS[@]}" -eq 0 ]
