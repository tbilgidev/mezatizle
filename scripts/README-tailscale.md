# Tailscale exposure (mezatizle)

Cloudflare tunnels are **not** used. Expose via Tailscale Funnel on `tolga-mini`.

## Ports

| Service | Port |
|---------|------|
| API (Bun) | `43127` |
| Web (production static + `/api` proxy) | `43128` |

## Funnel path (shared with other apps)

Do **not** `funnel reset` — root `/` is Ozy.

| Path | Port |
|------|------|
| `/mezatizle` | `43128` |

```bash
# API
FORCE_MOCK_ASR=1 FORCE_MOCK_OCR=1 EMBEDDED_WORKER=1 \
  DATABASE_URL=postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle \
  bun run apps/api/src/index.ts

# Web — production dist (recommended for Funnel; avoids Vite HMR blank pages)
bun run build:web && bun run serve:web

# Funnel path (does not reset other apps)
bash ~/projects/scripts/tailscale-funnel-paths.sh mezatizle
# or: ./scripts/setup-tailscale-mezatizle.sh
```

URL: `https://tolga-mini.tailf479ba.ts.net/mezatizle/`  
Health: `https://tolga-mini.tailf479ba.ts.net/mezatizle/api/health`
