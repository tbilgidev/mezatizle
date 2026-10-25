# Implementation status

Last updated: real LOCAL ASR/OCR path verified on tolga-mini (no FORCE_MOCK in live process).

## Verified

- [x] Environment: 4 CPU, ~11Gi RAM, no GPU; Bun; FFmpeg; Docker Postgres `:5433`
- [x] Bun monorepo (`apps/api`, `apps/web`, `packages/db`, `packages/shared`, workers)
- [x] Migrations `001`–`004` applied
- [x] Live capture (yt-dlp + ffmpeg) with optional duration, compact ≤720p encode
- [x] Ayarlar → Instagram oturumu (cookies / Playwright login → Netscape cookies for yt-dlp)
- [x] **faster-whisper** Turkish ASR (`base`, CPU int8) — default LOCAL provider
- [x] **Tesseract** comment OCR (system `tesseract` + `eng`; crop/stride/dedupe) — default LOCAL OCR  
      (PaddleOCR attempted; incompatible with this host’s Python 3.12 / numpy stack — code path kept, `OCR_ENGINE=paddle` when workable)
- [x] Auction segmentation + sale reconcile on real transcript/OCR (rules-first, no LLM)
- [x] Metrics + `api_usage` recorded for ASR/OCR/segment/sales
- [x] Embedded worker processes jobs **without** `FORCE_MOCK_*`
- [x] Smoke: `fixtures/sample-live.mp4` (~90s synthetic Turkish speech + burned comments) → `status=complete`  
      recording `8051df7d-f9c3-4c35-8416-5018a9e0bcc5`, wall ~75s, ASR source `faster_whisper`, OCR `ocr_tesseract` (5 lines), 2 sales
- [x] Funnel https://tolga-mini.tailf479ba.ts.net/mezatizle/ healthy
- [x] Unit tests still use `FORCE_MOCK_ASR=1 FORCE_MOCK_OCR=1 bun test` only

## Defaults (live)

| Knob | Value |
|------|--------|
| `PROCESSING_PROFILE` | `LOCAL` |
| `WHISPER_MODEL` | `base` |
| `OCR_ENGINE` | `tesseract` |
| Frame extract | 1 fps |
| OCR stride / cap | 3 / 200 frames |
| Live encode | ≤720p, 30 fps, CRF 26, AAC 96k, frag→faststart remux |

## Start

```bash
cd ~/projects/mezatizle
bash scripts/start-live.sh   # no FORCE_MOCK
# or: bun run start:live
```

## Partial

- [~] PaddleOCR: install blocked by numpy/OpenCV ABI on Py3.12 here — use tesseract
- [~] HYBRID/API paid paths: not exercised (no keys, limit 0)

## Not claimed

- Accuracy benchmarks on real multi-hour Instagram lives
- Production multi-tenant auth
