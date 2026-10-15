# Analysis pipeline — mezatizle (LOCAL)

**TR + EN technical brief** · Cost min · Miss few sales · Prefer unknown over wrong

Funnel: https://tolga-mini.tailf479ba.ts.net/mezatizle/  
Code: `~/projects/mezatizle` · Branch: `cursor/analysis-pipeline-tighten-de0f`

---

## 1. Stack today / Bugün ne kullanıyoruz

| Stage | Engine | Notes |
|-------|--------|--------|
| ASR | **faster-whisper** `small` (default after fixture eval), CPU **int8**, `language=tr`, VAD on, beam=1 | Override `WHISPER_MODEL=base` to save CPU |
| OCR | **Tesseract** (`eng`, PSM 6), comment **crop** `OCR_CROP_FRAC` | Paddle path kept but ABI-broken on this host |
| Frames | ffmpeg extract ~**1 fps**; OCR **change-aware** select ≤`OCR_MAX_FRAMES` (200–240) | Skip near-identical comment crops |
| Rules | `packages/shared/src/auction.ts` Turkish heuristics | **No LLM**, no paid API |
| Sales | `reconcileSales` → always `needs_review` | Gate: `SALE_MIN_CONFIDENCE` default **0.78** |
| Evidence | `sale_evidence` + enriched GET `/api/sales/:id/evidence` | Timestamps, transcript/OCR window, `explanationTr` |
| Reports | GET `/api/reports`, `/api/reports/:recordingId` | saleCount, sum TRY, needs_review, duration |

**Paid paths:** OFF. `PROCESSING_PROFILE=LOCAL` → `allowPaidApis=false`, `hardSpendLimitUsd=0`.

### Cost profile

| Item | Cost |
|------|------|
| OpenAI / Vision / cloud Whisper | **$0** (not called) |
| CPU (Whisper base on ~10 min) | ~1–2× realtime on 4c CPU; peak RAM ~1–2 GiB |
| OCR Tesseract | Dominated by frame count; change-aware keeps budget for 10–180 min lives |
| Disk | Compact live encode ≤720p CRF28 AAC 80k |

### A/V sync (master vs analysis extracts)

**Invariant:** The file in `storage/recordings/<id>.mp4` is the **master timeline**. ASR `start_ms`/`end_ms`, OCR `offset_ms`, auction events, and sales evidence all refer to this timeline. A desynced master makes analysis useless.

| Step | What happens | Sync rule |
|------|----------------|-----------|
| Live capture | yt-dlp URL(s) → **one** ffmpeg process → muxed H.264+AAC MP4 | Prefer progressive single URL; if adaptive video+audio URLs, dual `-i` in **same** encode. `fps=` filter (not bare `-r`), `aresample=async=1:first_pts=0`, `+genpts`, `-shortest` |
| Finalize / probe | `probeAvSync` (ffprobe video vs audio duration/start) | Warn if \|Δ\| > `LIVE_MAX_AV_SKEW_SEC` (default 0.35s). API: `GET /api/recordings/:id/av-sync` |
| Extract | WAV + JPG frames from master (**read-only**) | Never rewrite master. Frame `N` → offset `(N-1)/OCR_FPS` seconds on **master** PTS |
| Playback / Kanıt | `GET /api/recordings/:id/media` | Byte-Range 206 for seek; serves master as-is |

20 fps / 720p is OK: fps is applied in the video filter while audio is re-encoded in the same process, so A/V share one clock. OCR at ~1 fps is a **side extract only**.

---

## 2. Turkish mezat model (LOCAL rules)

**File:** `packages/shared/src/auction.ts` · window reconcile: `reconcileMezatWindows`

Seller «aldım X lira» is an **opening / listing (ask) price**, **not** a completed sale.

| Input | Event | Sale? |
|-------|-------|-------|
| Seller ASR `aldım on bin lira` | `price_mention` (`seller_aldim_ask`) | **No** — opens product window |
| First OCR comment `aldım` (+ username) after ask | `bid` (`aldim_claim`) | **Yes** at ask price when window closes / next lot (`aldim_first_comment`) |
| OCR `1200` / `18 veririm` | `bid` | Only after seller win/accept |
| Seller `satıldı @user`, `X’da kaldı`, `tebrikler @` | `sold` | Yes if `@` or OCR buyer correlated |
| Seller `tamam` / `olur` after counter | `sold` (`counter_accept`) | Yes at counter amount + OCR buyer |
| `Satıldı Mehmet` (spoken name, no `@`) | `sold` | **No sale row** — spoken ≠ username |
| `satılmadı` / `iptal` / `kalıyor` | `pass` | Window void |
| Seller ask with **no** follower claim | — | **No sale** (prefer unknown) |

**Product windows:** open on ask / intro; close on win confirm, unsold pass, or next ask (flushing first-aldım claim if any).

**Precision:** materialize a sale only with **buyer evidence** (OCR `@` / author username). `SALE_MIN_CONFIDENCE=0.78`. Status always `needs_review`.

---

## 3. OCR sampling / dedupe

**File:** `workers/extractor/tools.py`

1. Scan frames with stride; build tiny grayscale **signature** of comment crop.
2. OCR a frame when crop **changes** vs last kept (or fill to stride sample).
3. Cap at `OCR_MAX_FRAMES` (sane for ~10–180 min @ 1 fps).
4. **Fuzzy dedupe** (exact / containment / token Jaccard ≥0.85) — don’t invent lines; don’t spam duplicates.

---

## 4. Whisper: base vs small

**Script:** `scripts/eval-whisper-models.py` → writes `fixtures/whisper-base-vs-small.json`

| | base | small (new default) |
|--|------|----------------------|
| Fixture phraseScore (2026-10-15) | **3**/10 | **6**/10 (+3: sıradaki, 700, 450) |
| Wall on ~90s fixture | ~14s | ~45s (~3.1×) |
| Recommendation | CPU-saver override | **Default** after measured gain ≥2 and ratio &lt;3.5× |

Eval artifact: `fixtures/whisper-base-vs-small.json`. Re-run `scripts/eval-whisper-models.py` if fixtures change.

---

## 5. Evidence / Kanıt API (UI-ready data)

`GET /api/sales/:id/evidence` returns:

- `sale`, raw `evidence[]`
- `auctionEvent`, `offsetMs`
- `transcriptAround`, `commentsAround` (±`EVIDENCE_WINDOW_MS`, default 20s)
- `explanationTr`, `confidence`, `gaps` (`buyer_unknown`, `amount_unknown`, …)

Every materialized sale has ≥1 `sale_evidence` row; source transcript/comment linked when present. **Never invent** comments or buyers.

---

## 6. Reports API (for Raporlar UI)

```
GET /api/reports
GET /api/reports/:recordingId
```

Stable fields: `saleCount`, `needsReviewCount`, `sumAmountTry`, `durationSeconds`, plus detail sales/events/jobs. LOCAL only.

---

## 7. What stays unknown

- Exact Instagram Graph comments (we use OCR overlays / operator export)
- Buyer when seller only says a first name
- Amount when sold phrase has no number
- Multi-lot identity beyond heuristics (no LLM)
- Live anti-bot / private lives without cookies

---

## 8. Before / after (rules layer + gates)

Measured on **gold lines** in `tests/shared.test.ts` + `fixtures/sample-live.expected.json` (deterministic; no ASR variance):

| Metric | Before (old heuristics) | After (this branch) |
|--------|-------------------------|---------------------|
| `aldım` → sold (false positive) | Possible confusion with weak sold | **0** — always bid |
| Bare name → `buyer_username` | Risk of inventing | **Never** |
| Weak `satıldı` → sale row | Created | **Skipped** (&lt;0.78) |
| Strong `@user + TL` sold → sale | Yes | Yes, `needs_review` |
| Event-type recall on gold set | ~partial | **≥90%** (unit test) |
| Sale-worthy precision on gold solds | Lower | **2/2 strong, 0 weak** |
| Evidence explanation | Minimal | `explanationTr` + window |

**Smoke (real ASR/OCR, Whisper `small`, 2026-10-15):** recording `924526d8-…`, wall ~125s, 2 transcript segs, 5 OCR comments, 2 sales `needs_review`. Evidence API returns `explanationTr` + transcript/OCR window. Multi-sold ASR lines are **clause-split**; duplicate OCR+transcript lots **deduped**. Target gold: `@mehmet_demo` 700 + `@ayse_demo` 450 (via bid lookback when ASR lacks `@`).

---

## 9. Operator knobs

```bash
WHISPER_MODEL=base|small
OCR_ENGINE=tesseract
OCR_MAX_FRAMES=200
OCR_FRAME_STRIDE=2
SALE_MIN_CONFIDENCE=0.78
EVIDENCE_WINDOW_MS=20000
# never set FORCE_MOCK_* in live
```

Tests: `FORCE_MOCK_ASR=1 FORCE_MOCK_OCR=1 bun test`

---

## 10. Accuracy tradeoffs (honest)

- LOCAL rules **will miss** mumbled / overlapping sales → better than a wrong CSV row.
- OCR English lang pack: usernames/prices OK; Turkish diacritics in overlays may degrade — bids still often carry `@user` + digits.
- Whisper `base` may drop a short “satıldı”; burned comment OCR + bid lookback recovers many cases without paying for APIs.
- Human **Kanıt** review remains the source of truth (`needs_review` default).
