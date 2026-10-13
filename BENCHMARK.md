# Benchmark

Synthetic fixture only: `fixtures/sample-live.mp4` (~2s, 320×240).

Run:

```bash
FORCE_MOCK_ASR=1 FORCE_MOCK_OCR=1 bun run --filter @mezatizle/api benchmark
```

Raw output: `BENCHMARK.results.json`.

## Latest measured run (executed 2026-10-12T21:38:11Z)

Profile: `LOCAL` (mock ASR/OCR). Machine: 4× CPU, no GPU.

| Step | ms |
|------|-----|
| probe_ms | 58 |
| extract_ms | 93 |
| asr_mock_ms | 6 |
| ocr_mock_ms | 1 |
| segment_ms | 5 |
| reconcile_ms | 4 |
| **totalMs** | **167** |

Notes:

- Synthetic short clip — not a production live auction
- faster-whisper / PaddleOCR **not** installed; mock backends measured only
