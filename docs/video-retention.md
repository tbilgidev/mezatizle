# mezatizle — Video retention (7 days)

## Policy

Long mezats (4–5h, IG live restart) are normal → large videos are OK during and shortly after analysis.

**After analysis completes or fails terminally**, master video media is deleted once older than **`MEDIA_RETENTION_DAYS` (default 7)**.

| Deleted | Kept |
|---------|------|
| MP4 master / `.part.mp4` | `sales`, `sale_evidence` |
| comments ASS sidecar | report KPIs |
| `audio/<id>.wav` | `observed_comments` (text) |
| `frames/<id>/` raw OCR frames | `transcript_segments` |
| | product thumbs under `storage/products/` |
| | recording DB row (`media_purged_at` set) |

UI note when purged: **«Video 1 hafta sonra silindi; analiz duruyor»**

## Job

- Script: `scripts/purge-media-retention.ts` (+ `scripts/media-retention.sh`)
- Systemd user timer: `deploy/systemd/mezatizle-media-retention.timer` (every **6h**)
- Dry-run: `bun scripts/purge-media-retention.ts --dry-run`
- Never selects `bekleniyor` / `kaydediliyor` or in-flight `live_captures`
- Does **not** restart the API (safe while a live is recording)

Age anchor: `MAX(processing_jobs.finished_at)` for terminal jobs, else `recordings.updated_at`.

## Settings

Ayarlar → **Video saklama** shows the policy text (read-only; days via env).

## Deploy notes (tolga-mini)

1. `bun run migrate` (adds `media_purged_at`)
2. Install timer (user systemd) — hot script only
3. Rebuild/serve web for UI note
4. **API restart only when no `kaydediliyor`** — new `/media` → 410 + enrich flags need process reload

## Known future gap (not built now)

Instagram lives may restart after platform time limits. Multi-segment capture / reconnection is a known need; do not build full reconnection unless trivial.
