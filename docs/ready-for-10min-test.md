# Ready for ~10 minute live test

Funnel: https://tolga-mini.tailf479ba.ts.net/mezatizle/

## When you return — checklist

1. **Instagram session (if needed)**  
   Open **Ayarlar → Instagram oturumu (yedek hesap)**  
   https://tolga-mini.tailf479ba.ts.net/mezatizle/settings#ig-oturum  
   - Prefer Netscape `cookies.txt` upload, **or**  
   - **Playwright ile giriş yap** with spare watcher account (username/password; secrets never echoed).  
   Status should show cookies ready. Watch/record only — no posting/DM.

2. **Start a capture**  
   **Kayıtlar → Canlı yayın ekle**  
   - Paste live URL or `@username`  
   - Set **Kayıt süresi (dk) = 10** (hard-stop after 10 minutes; empty/0 = until live ends)  
   - Submit

3. **Watch progress**  
   - Same recording row: live status → file written under `storage/recordings/`  
   - Jobs: `probe` → `extract` → `transcribe` (faster-whisper) → `ocr_frames` (tesseract) → `segment_auction` → `reconcile_sales`  
   - Recording `status` becomes **`complete`**

4. **What “done” looks like**  
   - **Satışlar**: candidate sales with `needs_review`  
   - **Kanıt**: sale evidence linked to auction events  
   - Transcript segments `source=faster_whisper` (not `mock_asr`)  
   - Comments `source=ocr_tesseract` when overlays readable  

5. **If something fails**  
   - Re-check IG session; Instagram often blocks anonymous live pulls  
   - API log: `~/projects/mezatizle/logs/api.log`  
   - Restart without mocks: `cd ~/projects/mezatizle && bash scripts/start-live.sh`

## What is real vs mock

| Piece | Live process |
|-------|----------------|
| ASR | **Real** faster-whisper `base` CPU int8, language `tr` |
| OCR | **Real** system Tesseract (`eng`, cropped comment region, stride 3, dedupe) |
| Auction / sales | **Real** rules on transcript+OCR (no LLM) |
| Live capture | **Real** yt-dlp + ffmpeg (session optional but usually required) |
| PaddleOCR | **Not active** on this host (ABI clash); code path optional via `OCR_ENGINE=paddle` |
| FORCE_MOCK_* | **Unset** in live `.env` / start script; only for `bun test` |

## Smoke results (no real IG live)

- Fixture: `fixtures/sample-live.mp4` (~90s synthetic Turkish speech + burned comment panel)  
- Recording: `8051df7d-f9c3-4c35-8416-5018a9e0bcc5`  
- Wall time: **~75 s** end-to-end (`status=complete`)  
- ASR: 2 segments, `faster_whisper`  
- OCR: 5 deduped lines, `ocr_tesseract` (30 frames sampled)  
- Sales created for this recording: **2** (transcript + OCR “satildi”)  
- Smoke client RSS max: ~39 MiB (Whisper/Tesseract run in short-lived Python children; peak system RAM during ASR ~1–2 GiB for `base`)

### 10-minute path (configured, not live-recorded here)

| Stage | Expected on this mini (CPU) |
|-------|-----------------------------|
| Capture encode | ≤720p / 20fps / CRF28 / AAC80 → `storage/recordings/` |
| Extract | ~1 fps frames (~600); audio 16 kHz mono |
| ASR | Whisper `base` int8 — roughly order-of realtime to ~1.5× on 10 min |
| OCR | stride 3, max 200 frames, ≤8s/frame timeout — typically a few minutes |
| Disk | tens–hundreds of MB per 10 min at these encode settings (not 1080p) |
| OOM risk | Low if only one pipeline runs; avoid concurrent heavy OCR/ASR |

Duration box **10** enforces ffmpeg `-t` stop; finalize + enqueue analysis on duration **or** live end (whichever first).

## Screenshots

- `media/ig-settings-live.png` — Instagram oturumu  
- `media/recordings-nonmock.png` — completed non-mock recording  
- `media/sales-nonmock.png` — sales from real pipeline  

## Quality defaults (also in `docs/live-capture.md`)

720p cap · 20 fps · H.264 CRF 28 · AAC 80 kbps · Whisper `base` · OCR 1 fps extract / stride 3
