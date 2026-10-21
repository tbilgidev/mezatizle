#!/usr/bin/env bash
# Start mezatizle for real LOCAL ASR/OCR (no FORCE_MOCK_*).
set -euo pipefail
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Bun auto-loads .env from cwd — strip any mock flags from the process env.
unset FORCE_MOCK_ASR FORCE_MOCK_OCR || true
export PROCESSING_PROFILE="${PROCESSING_PROFILE:-LOCAL}"
export EMBEDDED_WORKER="${EMBEDDED_WORKER:-1}"
export LIVE_CAPTURE_SUPERVISOR="${LIVE_CAPTURE_SUPERVISOR:-1}"
export AUTO_FOLLOW_LIVE="${AUTO_FOLLOW_LIVE:-1}"
export AUTO_FOLLOW_LIVE_POLL_MS="${AUTO_FOLLOW_LIVE_POLL_MS:-330000}"
export DATABASE_URL="${DATABASE_URL:-postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle}"
export PYTHON_BIN="${PYTHON_BIN:-$ROOT/.venv/bin/python3}"
export WHISPER_MODEL="${WHISPER_MODEL:-small}"
export OCR_ENGINE="${OCR_ENGINE:-tesseract}"
export OCR_FPS="${OCR_FPS:-1}"
export FRAME_INTERVAL_SECONDS="${FRAME_INTERVAL_SECONDS:-1}"
# Watchable live masters — size via resolution/CRF, never low-FPS frame skip
export LIVE_MAX_HEIGHT="${LIVE_MAX_HEIGHT:-720}"
export LIVE_FPS="${LIVE_FPS:-30}"
export LIVE_CRF="${LIVE_CRF:-26}"
export LIVE_MAXRATE_K="${LIVE_MAXRATE_K:-2500}"
export LIVE_AUDIO_K="${LIVE_AUDIO_K:-96}"

mkdir -p storage/recordings storage/audio storage/frames storage/products storage/secrets logs

if command -v docker >/dev/null 2>&1; then
  if ! docker ps --format '{{.Names}}' | grep -qx mezatizle-postgres; then
    echo "[start] starting docker postgres…"
    docker compose up -d postgres 2>/dev/null || docker start mezatizle-postgres || true
  fi
fi

bun run migrate

# Stop previous by pid file (avoid pkill -f matching this script)
for f in logs/api.pid logs/web.pid; do
  if [[ -f "$f" ]]; then
    kill "$(cat "$f")" 2>/dev/null || true
  fi
done
sleep 1
# Free stale API listener (zombie parent can ignore TERM + keep :43127)
if command -v fuser >/dev/null 2>&1; then
  fuser -k 43127/tcp 2>/dev/null || true
  sleep 1
fi

# Explicitly clear mocks in the child env
nohup env -u FORCE_MOCK_ASR -u FORCE_MOCK_OCR \
  PROCESSING_PROFILE="$PROCESSING_PROFILE" \
  EMBEDDED_WORKER=1 \
  LIVE_CAPTURE_SUPERVISOR=1 \
  AUTO_FOLLOW_LIVE="$AUTO_FOLLOW_LIVE" \
  AUTO_FOLLOW_LIVE_POLL_MS="$AUTO_FOLLOW_LIVE_POLL_MS" \
  LIVE_MAX_HEIGHT="$LIVE_MAX_HEIGHT" \
  LIVE_FPS="$LIVE_FPS" \
  LIVE_CRF="$LIVE_CRF" \
  LIVE_MAXRATE_K="$LIVE_MAXRATE_K" \
  LIVE_AUDIO_K="$LIVE_AUDIO_K" \
  DATABASE_URL="$DATABASE_URL" \
  PYTHON_BIN="$PYTHON_BIN" \
  WHISPER_MODEL="$WHISPER_MODEL" \
  OCR_ENGINE="$OCR_ENGINE" \
  OCR_FPS="$OCR_FPS" \
  FRAME_INTERVAL_SECONDS="$FRAME_INTERVAL_SECONDS" \
  OCR_FRAME_STRIDE="${OCR_FRAME_STRIDE:-3}" \
  OCR_MAX_FRAMES="${OCR_MAX_FRAMES:-200}" \
  STORAGE_ROOT="$ROOT/storage" \
  bun run apps/api/src/index.ts >> logs/api.log 2>&1 &
echo $! > logs/api.pid
echo "[start] api pid=$(cat logs/api.pid)"

if [[ ! -d apps/web/dist ]]; then
  bun run build:web
fi
if [[ -f logs/web.pid ]] && kill -0 "$(cat logs/web.pid)" 2>/dev/null; then
  echo "[start] web already running pid=$(cat logs/web.pid)"
else
  nohup bun run scripts/serve-web.ts >> logs/web.log 2>&1 &
  echo $! > logs/web.pid
  echo "[start] web pid=$(cat logs/web.pid)"
fi

if [[ -x "$HOME/projects/scripts/tailscale-funnel-paths.sh" ]]; then
  bash "$HOME/projects/scripts/tailscale-funnel-paths.sh" mezatizle || true
fi

sleep 2
curl -sf "http://127.0.0.1:${API_PORT:-43127}/api/health" && echo
curl -s "http://127.0.0.1:${API_PORT:-43127}/api/settings" | head -c 400; echo
curl -sfI "https://tolga-mini.tailf479ba.ts.net/mezatizle/" | head -3 || true
echo "[start] ready — FORCE_MOCK unset"
