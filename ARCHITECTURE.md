# Architecture — mezatizle

## Overview

Local-first pipeline that turns **seller-owned** Instagram Live MP4 recordings (+ optional operator comment exports) into auction events, sale candidates, and a Turkish review dashboard.

```
MP4 upload → probe (ffprobe) → extract audio/frames (ffmpeg)
  → ASR (faster-whisper | mock) → OCR (PaddleOCR | mock)
  → auction segmentation (local rules) → sale reconciliation
  → Turkish dashboard / CSV export
```

## Monorepo layout

| Path | Role |
|------|------|
| `apps/api` | Bun + Hono API, embedded TS worker, benchmark |
| `apps/web` | Vite + React Turkish UI |
| `packages/db` | Postgres client, migrations, SKIP LOCKED queue |
| `packages/shared` | Validation, profiles, auction heuristics |
| `workers/extractor` | Python FFmpeg/ASR/OCR helpers |
| `modules/*` | Module A–H documentation stubs |
| `storage/` | Local filesystem media (not for secrets) |
| `fixtures/` | Synthetic sample MP4 |

## Modules A–H

| ID | Name | Implementation |
|----|------|----------------|
| A | Ingestion | `apps/api/src/modules/ingestion.ts` + FFmpeg |
| B | Transcription | `asr_ocr.ts` + `workers/extractor/tools.py` |
| C | Comments | `routes/comments.ts` operator import only |
| D | Auction events | `auction_pipeline.ts` + `shared/auction.ts` |
| E | Products/sales | reconcile + product frame image copy |
| F | Evidence/metrics | `sale_evidence`, `processing_metrics`, `api_usage` |
| G | Dashboard | `apps/web` pages |
| H | Capture | **Stub** — `capture_stub.ts` / POLICY.md |

## Data store

PostgreSQL tables: sellers, recordings, processing_jobs, transcript_segments, observed_comments, auction_events, products, sales, sale_evidence, processing_metrics, api_usage.

Queue: `processing_jobs` with `FOR UPDATE SKIP LOCKED`. No Redis/Kubernetes required.

## Processing profiles

See `packages/shared/src/profiles.ts`. Default `LOCAL`. Paid backends require env keys and still respect `HARD_SPEND_LIMIT_USD`.

## Security notes

- Secrets via `.env` only
- Upload type/size limits; filename + storage path traversal rejected
- Capture endpoints return 403 by design
