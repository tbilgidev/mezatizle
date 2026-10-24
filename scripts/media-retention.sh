#!/usr/bin/env bash
# mezatizle video media retention (pair with systemd timer).
# Deletes aged MP4/part/ASS/audio/raw frames; keeps sales/report/comments/transcript/thumbs.
# Safe during kaydediliyor — never selects active captures. Does NOT restart the API.
set -euo pipefail
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

LOG="$ROOT/logs/media-retention.log"
DATABASE_URL="${DATABASE_URL:-postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle}"
MEDIA_RETENTION_DAYS="${MEDIA_RETENTION_DAYS:-7}"
export DATABASE_URL MEDIA_RETENTION_DAYS
# shellcheck disable=SC1091
[[ -f "$ROOT/.env" ]] && set -a && source "$ROOT/.env" && set +a
export DATABASE_URL MEDIA_RETENTION_DAYS

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"
}

ARGS=("$@")
if [[ ${#ARGS[@]} -eq 0 ]]; then
  ARGS=()
fi

log "START retention_days=$MEDIA_RETENTION_DAYS args=${ARGS[*]:-}"
set +e
OUT="$(bun run "$ROOT/scripts/purge-media-retention.ts" "${ARGS[@]}" 2>&1)"
RC=$?
set -e
printf '%s\n' "$OUT" >>"$LOG"
if [[ "$RC" -ne 0 ]]; then
  log "ERROR exit=$RC"
  exit "$RC"
fi
log "OK"
echo "$OUT"
