#!/usr/bin/env bash
# mezatizle capture stall watchdog (oneshot).
# Detects kaydediliyor / finalizing rows whose media file stopped growing,
# then either nudges the in-process supervisor via API or runs a Bun tick
# that finalizes / opens part-2. Never deletes observed_comments.
#
# Quiet when healthy. Logs to logs/capture-stall-watchdog.log when acting.
set -euo pipefail
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

LOG="$ROOT/logs/capture-stall-watchdog.log"
API_URL="${API_URL:-http://127.0.0.1:43127}"
STALE_SEC="${LIVE_CAPTURE_STALE_BYTES_SEC:-180}"
FINALIZE_STUCK_SEC="${LIVE_FINALIZE_STUCK_SEC:-300}"
DATABASE_URL="${DATABASE_URL:-postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle}"
export PGPASSWORD="${PGPASSWORD:-mezatizle}"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"
}

http_ok() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 "$1" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]]
}

# Echo a reason line and return 0 when action needed; else return 1.
scan_stalled() {
  local rows id lc_status cap_status storage_path abs part target size mtime age
  rows="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -F '|' -c "
    SELECT r.id::text || '|' || COALESCE(lc.status,'?') || '|' ||
           COALESCE(r.capture_status,'?') || '|' ||
           COALESCE(r.storage_path,'')
    FROM recordings r
    JOIN live_captures lc ON lc.recording_id = r.id
    WHERE lc.status IN ('recording', 'finalizing')
       OR r.capture_status = 'kaydediliyor'
  " 2>/dev/null || true)"
  [[ -z "$rows" ]] && return 1
  while IFS='|' read -r id lc_status cap_status storage_path; do
    [[ -z "${id:-}" ]] && continue
    abs="$ROOT/storage/${storage_path}"
    part="${abs}.part.mp4"
    target=""
    if [[ -f "$part" ]]; then
      target="$part"
    elif [[ -f "$abs" ]]; then
      target="$abs"
    else
      continue
    fi
    size="$(stat -c%s "$target" 2>/dev/null || echo 0)"
    mtime="$(stat -c%Y "$target" 2>/dev/null || echo 0)"
    age=$(( $(date +%s) - mtime ))
    if [[ "$size" -lt 64000 ]]; then
      continue
    fi
    if [[ "$lc_status" == "finalizing" && "$age" -ge "$FINALIZE_STUCK_SEC" ]]; then
      echo "stuck_finalize id=$id age=${age}s size=$size"
      return 0
    fi
    if [[ "$cap_status" == "kaydediliyor" && "$age" -ge "$STALE_SEC" ]]; then
      echo "stale_bytes id=$id age=${age}s size=$size"
      return 0
    fi
  done <<<"$rows"
  return 1
}

main() {
  local hint=""
  if ! hint="$(scan_stalled)"; then
    exit 0
  fi
  log "DETECT ${hint}"

  if http_ok "${API_URL}/api/health"; then
    local code
    code="$(curl -sS -o /tmp/mz-stall-tick.json -w '%{http_code}' \
      --connect-timeout 3 --max-time 120 \
      -X POST "${API_URL}/api/recordings/stall-watchdog-tick" \
      -H 'content-type: application/json' \
      -d '{}' 2>/dev/null || echo 000)"
    log "API stall-watchdog-tick http=${code} body=$(head -c 240 /tmp/mz-stall-tick.json 2>/dev/null || true)"
    if [[ "$code" == "200" || "$code" == "202" ]]; then
      exit 0
    fi
  else
    log "API unhealthy — falling back to Bun oneshot tick"
  fi

  if bun run scripts/capture-stall-tick.ts >>"$LOG" 2>&1; then
    log "Bun stall tick OK"
  else
    log "Bun stall tick FAILED"
    exit 1
  fi
}

main "$@"
