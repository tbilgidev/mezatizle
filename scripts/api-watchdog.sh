#!/usr/bin/env bash
# mezatizle API (+ optional serve-web) health watchdog.
# Idempotent: exits quietly when healthy. Restarts API only when down.
# Does NOT kill python ASR/OCR unless they are children of a dead API we replace.
set -euo pipefail
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

API_PORT="${API_PORT:-43127}"
WEB_PORT="${WEB_PORT:-43128}"
API_URL="http://127.0.0.1:${API_PORT}"
WEB_URL="http://127.0.0.1:${WEB_PORT}"
LOG="$ROOT/logs/api-watchdog.log"
API_PID_FILE="$ROOT/logs/api.pid"
WEB_PID_FILE="$ROOT/logs/web.pid"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"
}

http_ok() {
  local url="$1"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 "$url" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]]
}

api_healthy() {
  http_ok "${API_URL}/api/health" || http_ok "${API_URL}/api/recordings"
}

web_healthy() {
  http_ok "${WEB_URL}/" || http_ok "${WEB_URL}/index.html"
}

# Kill only the mezatizle API bun process (pid file + listener on API_PORT). Never pkill python.
stop_api_only() {
  local oldpid=""
  if [[ -f "$API_PID_FILE" ]]; then
    oldpid="$(cat "$API_PID_FILE" 2>/dev/null || true)"
  fi
  if [[ -n "${oldpid:-}" ]] && kill -0 "$oldpid" 2>/dev/null; then
    # Only signal if it still looks like our API
    if tr '\0' ' ' <"/proc/$oldpid/cmdline" 2>/dev/null | grep -q 'apps/api/src/index.ts'; then
      kill "$oldpid" 2>/dev/null || true
      sleep 1
      kill -9 "$oldpid" 2>/dev/null || true
    else
      log "skip kill pid=$oldpid (cmdline is not mezatizle API)"
    fi
  fi
  # Free stale listener on API port only (do not touch WEB_PORT)
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${API_PORT}/tcp" 2>/dev/null || true
  fi
  sleep 1
}

start_api() {
  unset FORCE_MOCK_ASR FORCE_MOCK_OCR || true
  local DATABASE_URL PYTHON_BIN YT_DLP_PATH
  DATABASE_URL="${DATABASE_URL:-postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle}"
  PYTHON_BIN="${PYTHON_BIN:-$ROOT/.venv/bin/python3}"
  YT_DLP_PATH="${YT_DLP_PATH:-$ROOT/.venv/bin/yt-dlp}"

  nohup env -u FORCE_MOCK_ASR -u FORCE_MOCK_OCR \
    PROCESSING_PROFILE="${PROCESSING_PROFILE:-LOCAL}" \
    EMBEDDED_WORKER=1 \
    LIVE_CAPTURE_SUPERVISOR=1 \
    DATABASE_URL="$DATABASE_URL" \
    PYTHON_BIN="$PYTHON_BIN" \
    YT_DLP_PATH="$YT_DLP_PATH" \
    WHISPER_MODEL="${WHISPER_MODEL:-small}" \
    OCR_ENGINE="${OCR_ENGINE:-tesseract}" \
    TESSERACT_LANG="${TESSERACT_LANG:-tur+eng}" \
    TESSERACT_CONFIG="${TESSERACT_CONFIG:---psm 6 --oem 1}" \
    OCR_CROP_FRAC="${OCR_CROP_FRAC:-0.02,0.48,0.62,0.94}" \
    OCR_FPS="${OCR_FPS:-1}" \
    FRAME_INTERVAL_SECONDS="${FRAME_INTERVAL_SECONDS:-1}" \
    OCR_FRAME_STRIDE="${OCR_FRAME_STRIDE:-2}" \
    OCR_MAX_FRAMES="${OCR_MAX_FRAMES:-320}" \
    STORAGE_ROOT="$ROOT/storage" \
    bun run apps/api/src/index.ts >>logs/api.log 2>&1 &
  echo $! >"$API_PID_FILE"
  sleep 2
}

start_web_if_needed() {
  # Prefer existing healthy listener even if pid file is stale
  if web_healthy; then
    return 0
  fi
  if [[ -f "$WEB_PID_FILE" ]]; then
    local wpid
    wpid="$(cat "$WEB_PID_FILE" 2>/dev/null || true)"
    if [[ -n "${wpid:-}" ]] && kill -0 "$wpid" 2>/dev/null; then
      return 0
    fi
  fi
  if [[ ! -d apps/web/dist ]]; then
    log "web down and apps/web/dist missing — skip web restart"
    return 1
  fi
  nohup bun run scripts/serve-web.ts >>logs/web.log 2>&1 &
  echo $! >"$WEB_PID_FILE"
  sleep 1
  log "restarted serve-web pid=$(cat "$WEB_PID_FILE")"
}

main() {
  local api_ok=0 web_ok=0
  if api_healthy; then
    api_ok=1
  fi
  if web_healthy; then
    web_ok=1
  fi

  if [[ "$api_ok" -eq 1 && "$web_ok" -eq 1 ]]; then
    # Quiet success — optional heartbeat every run would spam; keep silent.
    exit 0
  fi

  if [[ "$api_ok" -eq 0 ]]; then
    local reason="api_unhealthy"
    if ! curl -sS --connect-timeout 2 "$API_URL/api/health" >/dev/null 2>&1; then
      reason="api_connection_failed_or_non_200"
    else
      reason="api_recordings_or_health_non_200"
    fi
    log "RESTART api reason=${reason} port=${API_PORT}"
    stop_api_only
    start_api
    if api_healthy; then
      log "api restart OK pid=$(cat "$API_PID_FILE" 2>/dev/null || echo '?')"
    else
      log "api restart FAILED — still unhealthy after start"
      exit 1
    fi
  fi

  if [[ "$web_ok" -eq 0 ]]; then
    log "RESTART serve-web reason=web_unhealthy port=${WEB_PORT}"
    start_web_if_needed || true
    if web_healthy; then
      log "serve-web OK"
    else
      log "serve-web still unhealthy"
    fi
  fi
}

main "$@"
