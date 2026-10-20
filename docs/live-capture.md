# mezatizle — Live capture

## Funnel

https://tolga-mini.tailf479ba.ts.net/mezatizle/

## Where to enter Instagram credentials

**Ayarlar → Instagram oturumu (yedek hesap)**  
https://tolga-mini.tailf479ba.ts.net/mezatizle/settings#ig-oturum

1. **Preferred:** Netscape `cookies.txt` (upload / paste / server path)
2. **Playwright ile giriş yap:** username + password → normal browser login as your spare watcher account → cookies exported for `yt-dlp --cookies`; password stored encrypted server-side (`••••`, never echoed back)
3. Optional: save username/password only (yt-dlp `-u/-p` fallback)

Use **your own backup account** (watch/record only). No private API / anti-bot kits. Consent & platform rules are the operator’s responsibility. Secrets are not logged.

## Default quality (watchable + analyzable)

| Setting | Default | Why |
|---------|---------|-----|
| Max height | **720p** | Size via resolution; never upscale |
| FPS | **30** CFR | Watchable; **do not** drop to 15–20 for size |
| Video | H.264 **CRF 26**, maxrate ~**2500 kbps**, `veryfast` | Size via CRF/bitrate |
| Audio | AAC **96 kbps** mono + `aresample=async=1` | ASR + A/V sync |
| Capture MP4 | `frag_keyframe+empty_moov+default_base_moof` | Forced stop still readable |
| Finalize | remux `-c copy +faststart` | Progressive moov for players |
| yt-dlp `-f` | `best[height<=720]/…` | Prefer ≤720 before ffmpeg |

Pipeline: Playwright/yt-dlp resolve → **ffmpeg** encode (fragmented part) → remux master → analysis.

Override via env: `LIVE_MAX_HEIGHT`, `LIVE_FPS`, `LIVE_CRF`, `LIVE_MAXRATE_K`, `LIVE_AUDIO_K`, `LIVE_YTDLP_FORMAT`.

**Comments (required):** Playwright viewer polls `get_comment` ~5s for the full capture → `observed_comments` (`live_api`), `offset_ms = comment_wall_ms − capture_started_at`. Same cues → ASS sidecar → finalize **burn-in HUD** on the master MP4 (Video open). If 0 comments after ~2 min kaydediliyor → log + UI **Yorum yok**. Ended lives cannot be backfilled. Watchdog must **not** restart a healthy viewer (that bug zeroed Yeşilköy comments).

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

## Auto-follow lives (watcher following list)

When **Ayarlar → Takip canlıları otomatik kaydet** is açık, the API polls the watcher IG following tray every **~5–6 minutes** (jitter) and starts the same live pipeline for a followed account that goes live — at most one concurrent auto recording; the IG scan pauses while any capture is `bekleniyor` / `kaydediliyor`. Manual **Canlı yayın ekle** still works. See Funnel settings `#auto-follow-live` and project store doc `auto-follow-live.md`. Env: `AUTO_FOLLOW_LIVE`, `AUTO_FOLLOW_LIVE_POLL_MS`.

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
