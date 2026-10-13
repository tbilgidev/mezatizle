#!/usr/bin/env bash
# mezatizle — Tailscale Funnel path helper (tolga-mini)
#
# Registers /mezatizle → :43128 WITHOUT funnel reset (keeps /, /palcrm, /etagate, /cloudbot).
#
# Usage:
#   ./scripts/tailscale-serve.sh          # add/update /mezatizle path
#   ./scripts/tailscale-serve.sh status
#   ./scripts/tailscale-serve.sh off      # remove only this path (best-effort)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_PORT="${MEZATIZLE_WEB_PORT:-43128}"
MEZATIZLE_PATH="${MEZATIZLE_PATH:-/mezatizle}"
MODE="${1:-serve}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale CLI not found on PATH" >&2
  exit 1
fi

case "$MODE" in
  status)
    tailscale funnel status 2>/dev/null || tailscale serve status || true
    ;;
  off)
    echo "To remove path ${MEZATIZLE_PATH}, reconfigure Funnel without it (no global reset from this script)."
    echo "Current:"
    tailscale funnel status 2>/dev/null || true
    ;;
  funnel|serve|*)
    # Prefer the path-safe setup script (no reset).
    exec bash "${ROOT}/scripts/setup-tailscale-mezatizle.sh"
    ;;
esac
