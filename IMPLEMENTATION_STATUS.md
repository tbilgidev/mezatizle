# Implementation status

Last updated during full MVP build (Phases 1–5). Claims below distinguish **verified** (executed here) vs **unverified**.

## Verified

- [x] Environment inspect (4 CPU, 15Gi RAM, no GPU; Bun installed; FFmpeg 6.1.1; Docker absent; Postgres 16 installed locally)
- [x] Bun monorepo scaffold (`apps/api`, `apps/web`, `packages/db`, `packages/shared`, workers)
- [x] Migrations `001_init` + `002_recording_statuses` applied
- [x] Module A: MP4 upload, probe, FFmpeg audio/frames, path/size validation
- [x] PG queue claim/complete (`SKIP LOCKED`)
- [x] Mock ASR → auction segment → sale reconcile with evidence + product image copy
- [x] Automated tests: **10 pass / 0 fail** (`FORCE_MOCK_ASR=1 FORCE_MOCK_OCR=1 bun test`)
- [x] Capture stub rejects unauthorized start
- [x] Turkish dashboard pages implemented (Panel, Kayıtlar, Satışlar, Kanıt, Ayarlar)
- [x] CSV export route `/api/sales/export.csv`
- [x] Docker Compose files authored (Compose **not** executed — Docker unavailable on this VM)

## Partial / fallback

- [~] faster-whisper: code path present; **not installed** → mock ASR used in tests
- [~] PaddleOCR: code path present; **not installed** → mock OCR used in tests
- [~] HYBRID/API profiles: resolved in code; paid paths **not exercised** (no keys, limit 0)

## Not claimed

- Instagram Live Playwright capture (intentionally stubbed)
- Production multi-tenant auth
- Real long-form live video accuracy benchmarks
