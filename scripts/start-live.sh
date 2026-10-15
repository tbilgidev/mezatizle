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
# Live probe/record loop (bekleniyor → kaydediliyor). Keep ON unless debugging.
export LIVE_CAPTURE_SUPERVISOR="${LIVE_CAPTURE_SUPERVISOR:-1}"
export DATABASE_URL="${DATABASE_URL:-postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle}"
export PYTHON_BIN="${PYTHON_BIN:-$ROOT/.venv/bin/python3}"
# Distro yt-dlp is often years behind and has no usable IG Live path — prefer venv.
export YT_DLP_PATH="${YT_DLP_PATH:-$ROOT/.venv/bin/yt-dlp}"
# small: better short TR sale phrases on fixture (~3× CPU vs base). Override with WHISPER_MODEL=base to save CPU.
export WHISPER_MODEL="${WHISPER_MODEL:-small}"
export OCR_ENGINE="${OCR_ENGINE:-tesseract}"
export OCR_FPS="${OCR_FPS:-1}"
export FRAME_INTERVAL_SECONDS="${FRAME_INTERVAL_SECONDS:-1}"

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

# Explicitly clear mocks in the child env
nohup env -u FORCE_MOCK_ASR -u FORCE_MOCK_OCR \
  PROCESSING_PROFILE="$PROCESSING_PROFILE" \
  EMBEDDED_WORKER=1 \
  LIVE_CAPTURE_SUPERVISOR=1 \
  DATABASE_URL="$DATABASE_URL" \
  PYTHON_BIN="$PYTHON_BIN" \
  YT_DLP_PATH="${YT_DLP_PATH:-$ROOT/.venv/bin/yt-dlp}" \
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
curl -s "http://127.0.0.1:${API_PORT:-43127}/api/health" | head -c 500; echo
curl -s "http://127.0.0.1:${API_PORT:-43127}/api/settings" | head -c 400; echo
curl -sfI "https://tolga-mini.tailf479ba.ts.net/mezatizle/" | head -3 || true
echo "[start] ready — FORCE_MOCK unset"
