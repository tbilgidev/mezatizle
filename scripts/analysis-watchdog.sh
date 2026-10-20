#!/usr/bin/env bash
# mezatizle analysis-job watchdog (pair with api-watchdog.sh).
# Every run: reclaim stuck "running" jobs, kill true orphan tools.py, ensure a drain worker.
# Does NOT restart the API. Does NOT delete recordings / live_api comments / transcripts.
set -euo pipefail
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

LOG="$ROOT/logs/analysis-watchdog.log"
DRAIN_PID_FILE="$ROOT/logs/analysis-drain.pid"
STALE_MINUTES="${ANALYSIS_JOB_STALE_MINUTES:-12}"
DATABASE_URL="${DATABASE_URL:-postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle}"
PYTHON_BIN="${PYTHON_BIN:-$ROOT/.venv/bin/python3}"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"
}

# Kill only orphan extractor children (PPID=1, mezatizle tools.py). Never touch API bun.
kill_orphan_tools() {
  local killed=0
  while read -r pid ppid cmd; do
    [[ -z "${pid:-}" ]] && continue
    if [[ "$ppid" == "1" ]] && [[ "$cmd" == *"mezatizle"*tools.py* || "$cmd" == *"/mezatizle/"*tools.py* ]]; then
      log "KILL orphan tools.py pid=$pid ppid=$ppid cmd=$cmd"
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      killed=$((killed + 1))
    fi
  done < <(ps -eo pid=,ppid=,args= | awk '/tools\.py (transcribe|ocr) / && $0 !~ /awk/ {print $1, $2, substr($0, index($0,$3))}')
  if [[ "$killed" -gt 0 ]]; then
    log "killed_orphans=$killed"
  fi
}

reclaim_stale_jobs() {
  local out n
  out="$(
    PGPASSWORD="${PGPASSWORD:-mezatizle}" psql -h 127.0.0.1 -p 5433 -U mezatizle -d mezatizle -v ON_ERROR_STOP=1 -At -q <<SQL
UPDATE processing_jobs
SET status = 'queued',
    locked_by = NULL,
    locked_at = NULL,
    stage = 'reclaimed_watchdog',
    error_message = COALESCE(error_message, 'reclaimed: analysis watchdog stale lock'),
    available_at = now(),
    updated_at = now()
WHERE status = 'running'
  AND GREATEST(locked_at, updated_at, started_at) < now() - make_interval(mins => ${STALE_MINUTES})
RETURNING id::text || ' type=' || job_type || ' rec=' || left(recording_id::text, 8);
SQL
  )" || {
    log "ERROR reclaim psql failed"
    return 1
  }
  n=0
  if [[ -n "${out:-}" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" || "$line" == UPDATE* ]] && continue
      log "RECLAIM $line stale_minutes=${STALE_MINUTES}"
      n=$((n + 1))
    done <<<"$out"
  fi
  if [[ "$n" -eq 0 ]]; then
    log "reclaim none stale_minutes=${STALE_MINUTES}"
  fi
}

# Prefer durable systemd drain unit; fall back to nohup only if systemctl unavailable.
ensure_drain_worker() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user is-active --quiet mezatizle-analysis-drain.service; then
      local pid
      pid="$(systemctl --user show -p MainPID --value mezatizle-analysis-drain.service 2>/dev/null || true)"
      [[ -n "${pid:-}" && "$pid" != "0" ]] && echo "$pid" >"$DRAIN_PID_FILE"
      return 0
    fi
    local queued
    queued="$(
      PGPASSWORD="${PGPASSWORD:-mezatizle}" psql -h 127.0.0.1 -p 5433 -U mezatizle -d mezatizle -At -c \
        "SELECT count(*) FROM processing_jobs WHERE status IN ('queued','running')"
    )" || queued=0
    if [[ "${queued:-0}" -eq 0 ]]; then
      return 0
    fi
    if systemctl --user start mezatizle-analysis-drain.service; then
      sleep 1
      local pid
      pid="$(systemctl --user show -p MainPID --value mezatizle-analysis-drain.service 2>/dev/null || true)"
      [[ -n "${pid:-}" && "$pid" != "0" ]] && echo "$pid" >"$DRAIN_PID_FILE"
      log "START mezatizle-analysis-drain.service pid=${pid:-?} OCR_MAX_FRAMES=${OCR_MAX_FRAMES:-120}"
      return 0
    fi
    log "WARN systemctl start drain failed — falling back to nohup"
  fi

  local live
  live="$(pgrep -f '/bun run apps/api/src/worker.ts' 2>/dev/null | head -1 || true)"
  if [[ -n "${live:-}" ]]; then
    echo "$live" >"$DRAIN_PID_FILE"
    return 0
  fi

  nohup env \
    SKIP_BOOT_RECLAIM=1 \
    WORKER_ID="analysis-drain-$$" \
    WORKER_POLL_INTERVAL_MS=1500 \
    JOB_STALE_MINUTES="${STALE_MINUTES}" \
    DATABASE_URL="$DATABASE_URL" \
    PYTHON_BIN="$PYTHON_BIN" \
    PROCESSING_PROFILE="${PROCESSING_PROFILE:-LOCAL}" \
    WHISPER_MODEL="${WHISPER_MODEL:-small}" \
    OCR_ENGINE="${OCR_ENGINE:-tesseract}" \
    TESSERACT_LANG="${TESSERACT_LANG:-tur+eng}" \
    TESSERACT_CONFIG="${TESSERACT_CONFIG:---psm 6 --oem 1}" \
    OCR_CROP_FRAC="${OCR_CROP_FRAC:-0.02,0.48,0.62,0.94}" \
    OCR_FPS="${OCR_FPS:-1}" \
    OCR_FRAME_STRIDE="${OCR_FRAME_STRIDE:-4}" \
    OCR_MAX_FRAMES="${OCR_MAX_FRAMES:-120}" \
    OCR_MAX_WIDTH="${OCR_MAX_WIDTH:-400}" \
    STORAGE_ROOT="$ROOT/storage" \
    bun run apps/api/src/worker.ts >>logs/analysis-drain.log 2>&1 &
  disown $! 2>/dev/null || true
  echo $! >"$DRAIN_PID_FILE"
  log "START drain nohup pid=$(cat "$DRAIN_PID_FILE") OCR_MAX_FRAMES=${OCR_MAX_FRAMES:-120}"
}

queue_summary() {
  PGPASSWORD="${PGPASSWORD:-mezatizle}" psql -h 127.0.0.1 -p 5433 -U mezatizle -d mezatizle -At -c \
    "SELECT status || '=' || count(*) FROM processing_jobs GROUP BY status ORDER BY 1" \
    | tr '\n' ' ' || true
}

main() {
  kill_orphan_tools
  reclaim_stale_jobs || true
  ensure_drain_worker
  log "ok queue=[$(queue_summary)] stale_minutes=${STALE_MINUTES}"
}

main "$@"
