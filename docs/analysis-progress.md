# Analysis progress % (API)

Exposed on `GET /api/recordings` and `GET /api/recordings/:id`:

| Field | Meaning |
|-------|---------|
| `analysisState` | `none` \| `running` \| `done` \| `failed` |
| `analysisProgress` | 0–100 weighted pipeline progress |
| `analysisStage` | Turkish label of current/next stage |

## Stage weights (sum = 100)

| Job | Weight | Label (TR) |
|-----|-------:|------------|
| `probe_media` | 5 | Medya kontrolü |
| `extract_audio_frames` | 15 | Ses/kare çıkarımı |
| `transcribe` | 40 | Ses çözülüyor (ASR) |
| `ocr_frames` | 20 | OCR (yorum kareleri) |
| `segment_auction` | 10 | Mezat olayları |
| `reconcile_sales` | 10 | Satış birleştirme |

- **succeeded** stage → full weight  
- **running** stage → `weight × (job.progress_percent / 100)`  
- **queued** / not started → 0 for that stage  

## Stale jobs

If a job stays `running` after API/worker restart (no heartbeat), `reclaimStaleRunningJobs` requeues it after `JOB_STALE_MINUTES` (default **30**).
