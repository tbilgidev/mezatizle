# Analysis pipeline — mezatizle (LOCAL)

**TR + EN technical brief** · Cost min · Miss few sales · Prefer unknown over wrong

Funnel: https://tolga-mini.tailf479ba.ts.net/mezatizle/  
Code: `~/projects/mezatizle` · Branch: `cursor/analysis-pipeline-tighten-de0f`

---

## 1. Stack today / Bugün ne kullanıyoruz

| Stage | Engine | Notes |
|-------|--------|--------|
| ASR | **faster-whisper** `small` (default), CPU **int8**, `language=tr`, VAD on, beam=1 | Quality over `base` for Turkish sale phrases |
| **Live comments** | Playwright poll `get_comment` every 5s while recording | **Primary** `@username`+«aldım» — DASH has **no** comment UI |
| OCR | **Tesseract** `tur+eng`, PSM 6, crop **bottom-left** `0.02,0.48,0.62,0.94` | Best-effort; ended DASH lives often OCR-blind |
| Frames | ffmpeg ~**1 fps**; change-aware ≤`OCR_MAX_FRAMES` (320) | Product thumbs from frames |
| Rules | `packages/shared` mezat windows | Seller ask ≠ sale; first follower aldım wins |
| Sales | `reconcileSales` → `needs_review` | Buyer evidence required |
| Reports KPIs | `productsOfferedCount/SumTry`, `productsSoldCount/SumTry`, `productsUnsoldCount`, `salesByMethod` | Headline: sunulan · satılan |

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

## 3. Comments + OCR (trust note — verified 2026-10-15)

**Critical:** Instagram Live **DASH** masters captured by ffmpeg are **camera video only**. The IG comment overlay is **not** burned into the stream. Spot-check of yesilkoy frames (bottom-left crop) showed **no readable comment text**; Tesseract returned glyph noise. Ended broadcast `get_comment` API returns `media has been deleted`.

| Source | When | Buyer usernames? |
|--------|------|------------------|
| `live_api` (Playwright poll during record) | **While live** | Yes — authoritative |
| OCR Tesseract on frames | After extract | Only if overlay somehow present (rare on DASH) |
| Operator `POST /api/comments` | Manual export | Yes |

**OCR when used** (`workers/extractor/tools.py`):

1. Crop **bottom-left** portrait comment stack (`OCR_CROP_FRAC=0.02,0.48,0.62,0.94`).
2. Upscale + autocontrast; `tur+eng` PSM 6 (eng PSM 11 fallback on timeout).
3. Change-aware denser sampling; parse `@user` / `username aldım` into `author_username` — **never invent**.
4. Fuzzy dedupe. Cap `OCR_MAX_FRAMES` (default 320).

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

KPI fields (always numeric, never null):

| Field | Alias | Meaning |
|-------|-------|---------|
| `productsOfferedCount` | `productsOffered` | Sunulan ürün (ask windows) |
| `productsOfferedSumTry` | `totalAskTry` | Satışa sunulan toplam tutar |
| `productsSoldCount` | `productsSold` | Satılan ürün |
| `productsSoldSumTry` | `totalSoldTry` | Toplam satış tutarı |
| `productsUnsoldCount` | | offered − sold |
| `salesByMethod` | | aldım / pey / counter split |
| `headline` | | sunulan · satılan · TRY · süre |

Also: `saleCount`, `needsReviewCount`, `sumAmountTry`, `durationSeconds`, detail sales/events/jobs. LOCAL only.

Ask-sum excludes ASR garbage amounts &gt; `OFFER_AMOUNT_SANITY_MAX_TRY` (100_000).

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


---

## 11. Yesilkoy keeper reanalyze (verified 2026-10-15)

**PYTHON_BIN hard fix:** absolute `/home/tolga/projects/mezatizle/.venv/bin/python3` in `.env` + `resolvePythonBin()` never returns `./.venv/...` (spawn cwd is `workers/extractor`).

| Recording | ASR (Whisper small) | Comments | Events | Sales | KPIs |
|-----------|---------------------|----------|--------|-------|------|
| `6c7e9508…` 20dk | **536** segments | 0 (DASH blind) | 81 | **0** | 59 sunulan · ≈475 316 TRY ask |
| `99b0f63c…` 15dk | **232** segments | 0 (DASH blind) | 69 | **0** | 38 sunulan · ≈100 415 TRY ask |
| `8e357c0a…` glam 60dk | paused | — | — | — | requeue later |

**Why 0 sales:** seller «aldım X» is ask (price_mention), not a sale. No `live_api` follower comments were stored during capture; OCR on DASH frames has no comment overlay. False `sold`/`counter_accept` ASR lines without buyer were correctly **not** materialized.

**Funnel:** after fix, `analysisState=done` / 100% (no ENOENT). Progress prefers running over stale failed jobs.
