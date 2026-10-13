# mezatizle

Instagram Live Auction Intelligence MVP — local-first processing for seller-owned live recordings.

**Hard rules:** no paid API calls by default, no Instagram login / private API /
credential stuffing / anti-bot bypass. Live capture uses public yt-dlp/ffmpeg only.

## Stack

- Bun + TypeScript monorepo (`apps/api`, `apps/web`, `packages/*`)
- PostgreSQL job queue (`FOR UPDATE SKIP LOCKED`)
- Python helpers for optional faster-whisper / PaddleOCR (mock fallback when absent)
- FFmpeg probe + audio/frame extraction
- React + Vite Turkish dashboard

## Quick start (no Docker)

This Cloud Agent image has **no Docker**. Use host Postgres + Bun:

```bash
# prerequisites: PostgreSQL 16, FFmpeg, Bun 1.4+, Python 3.12
cp .env.example .env
# create DB user/db matching DATABASE_URL

bun install
bun run migrate
bun run dev:api          # http://127.0.0.1:43127  (embedded worker on by default)
bun run dev:web          # http://127.0.0.1:43128
# optional dedicated worker:
# bun run apps/api/src/worker.ts
# python3 workers/extractor/worker.py
```

### Tailscale (preferred publish)

Do **not** use Cloudflare tunnels. On the operator Tailscale node (e.g. tolga-mini):

```bash
./scripts/tailscale-serve.sh          # Serve web :43128 on the tailnet
./scripts/tailscale-serve.sh funnel   # only if Funnel is enabled
```

See `scripts/README-tailscale.md`. Add a `mezatizle` entry to the shared Tailscale projects script pointing at port `43128`.

### Docker Compose (when Docker is available)

```bash
cp .env.example .env
docker compose up --build
```

## Tests

```bash
FORCE_MOCK_ASR=1 FORCE_MOCK_OCR=1 bun test
```

## Benchmark (synthetic fixture only)

```bash
FORCE_MOCK_ASR=1 bun run --filter @mezatizle/api benchmark
# writes BENCHMARK.results.json — update BENCHMARK.md with measured values only
```

## Processing profiles

| Profile | Behavior |
|---------|----------|
| `LOCAL` (default) | FFmpeg + local ASR/OCR or mock; paid APIs off |
| `HYBRID` | Local models preferred; still no paid calls without keys |
| `API` | Paid backends only if `OPENAI_API_KEY` / `VISION_API_KEY` set; respects `HARD_SPEND_LIMIT_USD` |

## Live capture (Module H)

Primary UI action: **Canlı yayın ekle** (`POST /api/recordings/live`).

1. Paste Instagram Live URL, profile URL, or `@username`
2. Supervisor probes with **yt-dlp** (no cookies/login from mezatizle)
3. When a public stream is resolvable → records to `storage/recordings/<id>.mp4`
4. When the live ends → finalizes file → enqueues the same analysis pipeline as uploads
5. Manual MP4 upload remains under “Gelişmiş”

**Instagram session:** **Ayarlar → Instagram oturumu (yedek hesap)** — cookies.txt,
Playwright login (spare watcher account), or encrypted username/password. Used as
`yt-dlp --cookies` / credentials. Secrets never returned after save.

**Capture quality default:** ≤720p, ~20 fps, H.264 CRF 28, AAC 80 kbps mono.
**Duration:** optional minutes on Canlı yayın ekle (empty = entire live).

**Instagram limit:** without a session many lives stay in `bekleniyor` / `engellendi`.
See `modules/h-capture-adapter/POLICY.md`.

Requires host tools: `yt-dlp`, `ffmpeg`.

## Modules A–H

See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [COST_MODEL.md](./COST_MODEL.md)
- [BENCHMARK.md](./BENCHMARK.md)
- [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)
