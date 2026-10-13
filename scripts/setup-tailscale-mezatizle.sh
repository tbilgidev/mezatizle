#!/usr/bin/env bash
# Tailscale Funnel: /mezatizle -> Vite :43128
# Kok / (Ozy), /palcrm, /etagate, /cloudbot korunur; reset YOK.
set -euo pipefail

MEZATIZLE_WEB_PORT="${MEZATIZLE_WEB_PORT:-43128}"
MEZATIZLE_PATH="${MEZATIZLE_PATH:-/mezatizle}"

run_funnel() {
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo tailscale funnel --bg --set-path="${MEZATIZLE_PATH}" "${MEZATIZLE_WEB_PORT}"
    return
  fi
  if tailscale funnel --bg --set-path="${MEZATIZLE_PATH}" "${MEZATIZLE_WEB_PORT}"; then
    return
  fi
  echo ""
  echo "Yetki gerekli. Bir kez (onerilen):"
  echo "  sudo tailscale set --operator=$USER"
  echo ""
  echo "Veya simdi:"
  echo "  sudo tailscale funnel --bg --set-path=${MEZATIZLE_PATH} ${MEZATIZLE_WEB_PORT}"
  exit 1
}

echo "==> Tailscale Funnel path ${MEZATIZLE_PATH} -> :${MEZATIZLE_WEB_PORT}"
echo "    (kok / ve diger pathler silinmez)"

run_funnel

echo ""
echo "Durum:"
tailscale funnel status 2>/dev/null || true
echo ""

BASE="$(tailscale funnel status 2>/dev/null | grep -oE 'https://[a-z0-9.-]+\.ts\.net' | head -1 || true)"
if [[ -z "${BASE}" ]]; then
  BASE="https://tolga-mini.tailf479ba.ts.net"
fi

echo "mezatizle UI:   ${BASE}${MEZATIZLE_PATH}/"
echo "API (proxy):    ${BASE}${MEZATIZLE_PATH}/api/health"
echo ""
echo "Yerel: Vite :${MEZATIZLE_WEB_PORT} ve API :43127 ayakta olmali."
echo "  FORCE_MOCK_ASR=1 FORCE_MOCK_OCR=1 EMBEDDED_WORKER=1 bun run apps/api/src/index.ts"
echo "  bun run --filter @mezatizle/web dev"
