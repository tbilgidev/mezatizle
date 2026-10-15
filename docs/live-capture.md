# mezatizle — Live capture

## 2026-10-15 — Live detect fix

**Root cause:** yt-dlp has no Instagram Live extractor (`[generic]` → HTTP 429). Browser-watchable lives still need spare-account cookies. Misleading copy said “herkese açık bulunamadı”.

**Fix:** Prefer `.venv/bin/yt-dlp`; Playwright+cookies resolve `broadcast_id` + DASH via same-origin live info; surface real errors (429/login/not live); preserve `broadcast_id` in URLs; cancel `smoke_seller` junk; start `kaydediliyor` when DASH found.

See agent store `docs/live-capture.md` for full probe log summary.

## Funnel

https://tolga-mini.tailf479ba.ts.net/mezatizle/

## Where to enter Instagram credentials

**Ayarlar → Instagram oturumu (yedek hesap)**  
https://tolga-mini.tailf479ba.ts.net/mezatizle/settings#ig-oturum

1. **Preferred:** Netscape `cookies.txt` (upload / paste / server path)
2. **Playwright ile giriş yap:** username + password → normal browser login as your spare watcher account → cookies exported for `yt-dlp --cookies`; password stored encrypted server-side (`••••`, never echoed back)
3. Optional: save username/password only (yt-dlp `-u/-p` fallback)

Use **your own backup account** (watch/record only). No private API / anti-bot kits. Consent & platform rules are the operator’s responsibility. Secrets are not logged.

## Default quality (disk vs analysis)

| Setting | Default | Why |
|---------|---------|-----|
| Max height | **720p** | Enough for comment/product OCR; not 1080p bloat |
| FPS | **20** | Speech + overlays; long lives stay smaller |
| Video | H.264 **CRF 28**, maxrate ~**1800 kbps**, `veryfast` | Analyzable, compact |
| Audio | AAC **80 kbps** mono | Enough for Turkish ASR |
| yt-dlp `-f` | `best[height<=720]/…` | Prefer ≤720 before ffmpeg |

Pipeline: resolve stream with yt-dlp (`-g`) → **ffmpeg** live encode to `storage/recordings/<id>.mp4`.

Override via env: `LIVE_MAX_HEIGHT`, `LIVE_FPS`, `LIVE_CRF`, `LIVE_MAXRATE_K`, `LIVE_AUDIO_K`, `LIVE_YTDLP_FORMAT`.

## Analysis (LOCAL, no mocks)

| Stage | Provider |
|-------|----------|
| ASR | **faster-whisper** `base`, CPU int8, `language=tr` |
| OCR | **Tesseract** (comment crop + stride/dedupe); Paddle optional if ABI OK |
| Auction/sales | Rules on transcript + OCR (no paid LLM) |

See also: `docs/ready-for-10min-test.md` (operator checklist + smoke timings).

## Duration control (Canlı yayın ekle)

- **Kayıt süresi (dk)** number box
- Empty or **0** = record the **entire** live until it ends
- e.g. `10`, `180` = hard-stop after N minutes (`ffmpeg -t`) even if live continues
- Whichever comes first (live end **or** duration) → finalize MP4 → enqueue ASR/OCR/sales pipeline

## Screenshots

- `media/ig-settings-live.png` — Instagram oturumu / Playwright
- `media/recordings-nonmock.png` — completed real-pipeline recording
- `media/sales-nonmock.png` — sales from real ASR/OCR
- `media/live-capture-ui.png` — Canlı yayın ekle (+ süre)

## Restart (no FORCE_MOCK)

```bash
cd ~/projects/mezatizle
bash scripts/start-live.sh
# equivalent: bun run start:live
```
