# Live comments — dual capture (text + burn-in)

## Requirement

Every live capture (manual **Canlı yayın ekle** + auto-follow) must:

1. Poll IG `get_comment` for the **full** recording duration → `observed_comments` (`source=live_api`), `offset_ms` vs `capture_started_at`.
2. Burn a readable comment HUD into the finalized MP4 (Video open shows comments in-frame).

Yeşilköy `8dcb0555-…` (2026-10-20) cannot be backfilled — live ended; IG returns 404 for past broadcasts.

## Root cause (Yeşilköy 0 comments)

Supervisor `tickRecordingWatchdogs` called `startLiveViewerPresence` **every ~20s** while ffmpeg was alive. That function always `stopLiveViewerPresence` first → Playwright torn down continuously → comment poll never stayed up (`Target page… closed`). Launch failures also lacked `.catch` → silent miss. Result: A/V OK, **0** `live_api` rows.

## Fix

| Lever | Behavior |
|-------|----------|
| `ensureLiveViewerPresence` | Reuse healthy session; restart only if heartbeat/poll unhealthy |
| Loud failures | `chromium.launch` try/catch; `attachViewerPresence` `.catch` + `console.error` |
| Drought | After **2 min** kaydediliyor with 0 `live_api` → log `DROUGHT` + `comments_warning='Yorum yok'` |
| UI | Kayıtlar badge **Yorum yok** / **N yorum** |
| ASS sidecar | Each insert appends cue to `recordings/<id>.comments.ass` |
| Finalize burn-in | After remux: ffmpeg `subtitles=` re-encode video, **`-c:a copy`** (A/V sync preserved); then +faststart already on remux |

## Burn-in approach

- **Not** Playwright page screencast into ffmpeg (would fight A/V pipeline / FPS).
- **Yes** text poll → ASS cues timed by `offset_ms` → one finalize pass burns HUD (DejaVu Sans strip, ~8s hold per comment).
- Constraints kept: ≤720p master already encoded; burn does not re-scale; 30fps master unchanged; auto-follow pause/5–6min poll untouched.

## Operator check next live

1. Kayıtlar → while kaydediliyor, within ~2 min you should see **N yorum** (or **Yorum yok** if poll dead).
2. After **bitti**, open **Video** — comments appear as lower-left HUD aligned to speech.
3. Report still uses `observed_comments` for analysis (burn-in is human QC only).

Env: `LIVE_COMMENT_DROUGHT_MIN` (default `2`).
