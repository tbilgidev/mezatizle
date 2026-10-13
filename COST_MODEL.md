# Cost model

Default profile **LOCAL**: $0 API spend. Compute is operator CPU/disk time.

## Cost centers

| Center | LOCAL | HYBRID | API (keys required) |
|--------|-------|--------|---------------------|
| FFmpeg extract | CPU only | CPU only | CPU only |
| ASR | faster-whisper or mock | faster-whisper | OpenAI Whisper API if keyed |
| OCR | PaddleOCR or mock | PaddleOCR | Vision API if keyed |
| LLM auction parse | local regex rules | local rules | optional OpenAI if keyed |
| Postgres / storage | self-hosted | self-hosted | self-hosted |

## Hard spend limit

`HARD_SPEND_LIMIT_USD` (default `0` for LOCAL). Workers/API call `assertUnderSpendLimit` before paid work. Usage rows go to `api_usage` with `unit_cost_usd` (local ops record `0`).

## What we do not provision

- No paid cloud DB / Redis / managed GPU by default
- No Instagram API fees
- No automatic model downloads billed through third-party APIs in LOCAL

## Operator cost tips

- Prefer `FORCE_MOCK_ASR=1` / `FORCE_MOCK_OCR=1` in CI
- Use Whisper `tiny`/`base` on CPU if enabling real ASR
- Cap `FRAME_INTERVAL_SECONDS` to reduce OCR volume
