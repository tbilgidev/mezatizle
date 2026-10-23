#!/usr/bin/env bash
# mezatizle analysis-job watchdog (pair with api-watchdog.sh).
# Every ~5 min (systemd timer): detect stuck "running" jobs, salvage or reclaim,
# kill true orphan tools.py, ensure a drain worker.
#
# Stuck = status=running AND heartbeat timestamps stale AND no live tools.py child
# for that recording. Heartbeats refresh updated_at/locked_at every ~25s while
# ASR/OCR run — duration-scaled windows are NOT used (they hid OOM zombies for hours).
#
# Does NOT restart the API. Does NOT start live capture.
# Does NOT delete recordings / live_api comments / transcripts (salvage prefers
# marking stuck ASR succeeded when a full transcript already exists).
set -euo pipefail
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

LOG="$ROOT/logs/analysis-watchdog.log"
STATE_FILE="$ROOT/logs/analysis-watchdog.state"
DRAIN_PID_FILE="$ROOT/logs/analysis-drain.pid"
# Default 5 minutes — matches mezatizle-analysis-watchdog.timer OnUnitActiveSec.
STALE_MINUTES="${ANALYSIS_JOB_STALE_MINUTES:-5}"
PROGRESS_STALE_MINUTES="${ANALYSIS_PROGRESS_STALE_MINUTES:-$STALE_MINUTES}"
DATABASE_URL="${DATABASE_URL:-postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle}"
PYTHON_BIN="${PYTHON_BIN:-$ROOT/.venv/bin/python3}"
PSQL=(psql -h 127.0.0.1 -p 5433 -U mezatizle -d mezatizle)
export PGPASSWORD="${PGPASSWORD:-mezatizle}"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"
}

# True if a mezatizle tools.py (transcribe|ocr) child is alive for recording_id.
live_tools_for_recording() {
  local rid="$1"
  ps -eo args= | awk -v rid="$rid" '
    $0 ~ /tools\.py (transcribe|ocr) / && index($0, rid) { found=1; exit }
    END { exit found ? 0 : 1 }
  '
}

# Kill only orphan extractor children (PPID=1, mezatizle tools.py). Never touch API bun / ffmpeg capture.
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

# Salvage stuck ASR when a near-full transcript already exists (avoid tools.py DELETE + re-run).
salvage_stuck_transcribe() {
  local out n=0
  out="$(
    "${PSQL[@]}" -v ON_ERROR_STOP=1 -At -q <<SQL
WITH stuck AS (
  SELECT pj.id, pj.recording_id, pj.progress_percent, pj.stage
  FROM processing_jobs pj
  WHERE pj.status = 'running'
    AND pj.job_type = 'transcribe'
    AND GREATEST(pj.locked_at, pj.updated_at, pj.started_at)
        < now() - make_interval(mins => ${STALE_MINUTES})
),
cover AS (
  SELECT s.id,
         s.recording_id,
         COALESCE((
           SELECT max(ts.end_ms)::float / 1000.0
           FROM transcript_segments ts
           WHERE ts.recording_id = s.recording_id
         ), 0) AS max_end_s,
         COALESCE((
           SELECT r.duration_seconds FROM recordings r WHERE r.id = s.recording_id
         ), 0) AS dur_s,
         COALESCE((
           SELECT count(*) FROM transcript_segments ts WHERE ts.recording_id = s.recording_id
         ), 0) AS segs
  FROM stuck s
)
UPDATE processing_jobs pj
SET status = 'succeeded',
    progress_percent = 100,
    stage = 'done',
    finished_at = now(),
    locked_by = NULL,
    locked_at = NULL,
    error_message = 'salvaged: watchdog — full transcript present, ASR worker dead',
    result_json = jsonb_build_object(
      'salvaged', true,
      'segments', c.segs,
      'max_end_s', c.max_end_s,
      'duration_s', c.dur_s,
      'reason', 'watchdog_transcript_salvage'
    ),
    updated_at = now()
FROM cover c
WHERE pj.id = c.id
  AND c.segs > 0
  AND c.dur_s > 0
  AND c.max_end_s >= c.dur_s * 0.95
RETURNING pj.id::text || ' segs=' || c.segs::text || ' rec=' || left(pj.recording_id::text, 8);
SQL
  )" || {
    log "ERROR salvage_transcribe psql failed"
    return 1
  }
  if [[ -n "${out:-}" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" || "$line" == UPDATE* ]] && continue
      log "SALVAGE_TRANSCRIBE $line"
      n=$((n + 1))
    done <<<"$out"
  fi
  return 0
}

# Reclaim stale running jobs with no live tools.py child for that recording.
reclaim_stale_jobs() {
  local out n=0 line job_id job_type rec_id
  # List candidates (stale by heartbeat), then skip any with a live child.
  out="$(
    "${PSQL[@]}" -v ON_ERROR_STOP=1 -At -q <<SQL
SELECT pj.id::text || '|' || pj.job_type || '|' || pj.recording_id::text || '|' ||
       COALESCE(pj.progress_percent,0)::text || '|' || COALESCE(pj.stage,'')
FROM processing_jobs pj
WHERE pj.status = 'running'
  AND GREATEST(pj.locked_at, pj.updated_at, pj.started_at)
      < now() - make_interval(mins => ${STALE_MINUTES})
ORDER BY pj.updated_at ASC;
SQL
  )" || {
    log "ERROR reclaim list psql failed"
    return 1
  }

  if [[ -z "${out:-}" ]]; then
    log "reclaim none stale_minutes=${STALE_MINUTES}"
    return 0
  fi

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    job_id="${line%%|*}"
    rest="${line#*|}"
    job_type="${rest%%|*}"
    rest2="${rest#*|}"
    rec_id="${rest2%%|*}"
    if live_tools_for_recording "$rec_id"; then
      log "SKIP live_child type=$job_type rec=${rec_id:0:8} id=${job_id:0:8}"
      continue
    fi
    "${PSQL[@]}" -v ON_ERROR_STOP=1 -At -q <<SQL >/dev/null
UPDATE processing_jobs
SET status = 'queued',
    locked_by = NULL,
    locked_at = NULL,
    stage = 'reclaimed_watchdog',
    error_message = COALESCE(error_message, 'reclaimed: analysis watchdog stale lock (no live worker)'),
    available_at = now(),
    updated_at = now()
WHERE id = '${job_id}'::uuid
  AND status = 'running';
SQL
    log "RECLAIM id=${job_id:0:8} type=$job_type rec=${rec_id:0:8} stale_minutes=${STALE_MINUTES}"
    n=$((n + 1))
  done <<<"$out"

  if [[ "$n" -eq 0 ]]; then
    log "reclaim none (all skipped or none) stale_minutes=${STALE_MINUTES}"
  fi
}

# Progress-% fingerprint: running job with unchanged progress/stage for N minutes
# and no live child → reclaim even if something else kept updated_at warm.
# State file lines: job_id|progress|stage|first_seen_epoch
check_progress_fingerprint() {
  local now_epoch job_id job_type rec_id prog stage first_seen
  now_epoch="$(date +%s)"
  touch "$STATE_FILE"
  : >"$STATE_FILE.tmp_new"

  while IFS='|' read -r job_id job_type rec_id prog stage; do
    [[ -z "${job_id:-}" ]] && continue
    first_seen="$(awk -F'|' -v j="$job_id" -v p="$prog" -v s="$stage" \
      '$1==j && $2==p && $3==s {print $4; exit}' "$STATE_FILE" 2>/dev/null || true)"
    if [[ -z "${first_seen:-}" ]]; then
      echo "${job_id}|${prog}|${stage}|${now_epoch}" >>"$STATE_FILE.tmp_new"
      continue
    fi
    echo "${job_id}|${prog}|${stage}|${first_seen}" >>"$STATE_FILE.tmp_new"
    if (( now_epoch - first_seen < PROGRESS_STALE_MINUTES * 60 )); then
      continue
    fi
    if live_tools_for_recording "$rec_id"; then
      log "PROGRESS_STALE skip live_child type=$job_type rec=${rec_id:0:8}"
      continue
    fi
    if [[ "$job_type" == "transcribe" ]]; then
      salvage_stuck_transcribe || true
    fi
    if ! "${PSQL[@]}" -At -c "SELECT status FROM processing_jobs WHERE id='${job_id}'::uuid" | grep -qx running; then
      continue
    fi
    "${PSQL[@]}" -v ON_ERROR_STOP=1 -At -q <<SQL >/dev/null
UPDATE processing_jobs
SET status = 'queued',
    locked_by = NULL,
    locked_at = NULL,
    stage = 'reclaimed_progress_stale',
    error_message = COALESCE(error_message, 'reclaimed: analysis progress unchanged ${PROGRESS_STALE_MINUTES}m'),
    available_at = now(),
    updated_at = now()
WHERE id = '${job_id}'::uuid
  AND status = 'running';
SQL
    log "RECLAIM_PROGRESS id=${job_id:0:8} type=$job_type rec=${rec_id:0:8} prog=$prog stage=$stage held_min=${PROGRESS_STALE_MINUTES}"
  done < <(
    "${PSQL[@]}" -At -q <<SQL
SELECT id::text, job_type, recording_id::text,
       COALESCE(progress_percent,0)::text, COALESCE(stage,'')
FROM processing_jobs
WHERE status = 'running';
SQL
  )

  mv "$STATE_FILE.tmp_new" "$STATE_FILE"
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
      "${PSQL[@]}" -At -c \
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
  "${PSQL[@]}" -At -c \
    "SELECT status || '=' || count(*) FROM processing_jobs GROUP BY status ORDER BY 1" \
    | tr '\n' ' ' || true
}

main() {
  kill_orphan_tools
  salvage_stuck_transcribe || true
  reclaim_stale_jobs || true
  check_progress_fingerprint || true
  ensure_drain_worker
  log "ok queue=[$(queue_summary)] stale_minutes=${STALE_MINUTES} progress_stale_minutes=${PROGRESS_STALE_MINUTES}"
}

main "$@"
