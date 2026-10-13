# Tailscale exposure (mezatizle)

Cloudflare tunnels are **not** used. Expose via Tailscale Funnel on `tolga-mini`.

## Ports

| Service | Port |
|---------|------|
| API (Bun) | `43127` |
| Web (Vite, `/api` proxy) | `43128` |

## Funnel path (shared with other apps)

Do **not** `funnel reset` — root `/` is Ozy.

| Path | Port |
|------|------|
| `/mezatizle` | `43128` |

```bash
# shared registry
bash ~/projects/scripts/tailscale-funnel-paths.sh mezatizle

# or project helper
./scripts/setup-tailscale-mezatizle.sh
```

URL: `https://tolga-mini.tailf479ba.ts.net/mezatizle/`
Health: `https://tolga-mini.tailf479ba.ts.net/mezatizle/api/health`
