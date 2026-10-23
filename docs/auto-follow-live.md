# Auto-capture followed mezat lives

## Funnel

- App: https://tolga-mini.tailf479ba.ts.net/mezatizle/
- Settings (toggle): https://tolga-mini.tailf479ba.ts.net/mezatizle/settings#auto-follow-live
- IG session: https://tolga-mini.tailf479ba.ts.net/mezatizle/settings#ig-oturum
- Recordings: https://tolga-mini.tailf479ba.ts.net/mezatizle/recordings

Watcher account: **nihan.dogansoy** (cookies already loaded). Operator only follows mezat sellers.

## Evening-only scan schedule (ban-safer)

Auto-follow **no longer** polls every 5–6 minutes.

| Slot (Europe/Istanbul) | Action |
|------------------------|--------|
| **20:05** | Tray + rotating following probes; start at most one capture if none active |
| **21:05** | Same |
| **22:05** | Same |

- Outside these windows: **no** tray / following / profile probe sweeps for auto-follow.
- Manual **Canlı yayın ekle** remains available anytime.
- If any recording is `bekleniyor` / `kaydediliyor` (or live_capture in-flight): **skip that slot** (`scanPaused`); no IG hits. DB re-check ~30s.
- Inside a slot, probe gaps stay ban-safe (700–1400 ms); on **429**, do **not** retry the same slot — wait for the next evening window (backoff ≥12 min still applied if longer).
- Status fields: `nextScanAt`, `scanWindowsTr` (`20:05, 21:05, 22:05`), `scanTimezone` (`Europe/Istanbul`), `scheduleHintTr`.

In-process scheduler (same API loop as before) — not a separate systemd timer.

## How full-following coverage works

1. Background scheduler runs when `AUTO_FOLLOW_LIVE≠0` and the toggle is **açık**.
2. At each evening slot, Playwright opens Instagram with watcher cookies.
3. **Prefer tray first:** same-origin `feed/reels_tray/` (+ HTML live signals). One browser session per poll.
4. **Persisted following cache** (`storage/config/ig-following-cache.json`): paginated `friendships/{ds_user_id}/following/` refresh about every **6 hours** (polite page gaps ~0.5–0.9s). Not fetched every poll.
5. **Tray-miss fallback = rotating full following probes**:
   - Each slot profile-probes up to **N=8** usernames (`AUTO_FOLLOW_PROBE_BATCH`, clamp 3–12) from the cached following list, advancing a cursor.
   - Soft «öncelik» usernames (afra / glam / nunus / recent lives) are only **ordered earlier** — they are **not** the coverage set.
   - Gap between `web_profile_info` probes: **700–1400 ms** jitter; stop the batch on HTTP **429**.
6. **Full sweep ETA** stretches across multiple evenings (3 slots/night). Sweep **skips slots while any recording is active**.
7. Each poll is hard-capped (~**120s**).
8. **Hard rule — single capture (auto):** never enqueue a second concurrent recording. Operators may cut early (see below).
9. Manual **Canlı yayın ekle** and auto-follow both **dedupe** globally (one active capture) and by username/`broadcast_id`.
10. Live supervisor records ≤720p / 30fps / A/V sync + comment poll until the live ends → moov-safe finalize → analysis enqueue.

## Operator manual cutover

Auto never starts a second capture while one is active.

**Exception for operators:**

| Action | API | UI |
|--------|-----|----|
| Stop early (finalize + analysis) | `POST /api/recordings/:id/stop-live` | Kayıtlar → **Kaydı kes** |
| Cut + start new | `POST /api/recordings/cutover` `{ input, stopRecordingId? }` | **Kes ve şunu kaydet** |
| Discard wait (no analysis) | `POST /api/recordings/:id/cancel-live` | **İptal** |

Cut recording is **analyzed** (not discarded). Flow: Stop → Start, or single cutover.

Starting a second capture **without** stop still returns the in-flight row (`deduped: true`, `globalSingle: true` when different seller).

## Loud failure (not silent)

| Signal | Where |
|--------|--------|
| `healthOk: false` + `healthAlertTr` | `GET /api/settings/auto-follow-live` |
| Sidebar **Durum — UYARI** | Missed evening slot, cookies missing, loop not started, or API down |
| Settings badge **Poller uyarısı** | Same alert text under auto-follow card |

Missed-slot alert: most recent Istanbul slot is >~12 min past and `lastPollAt` is before that slot (while enabled & not `scanPaused`). Daytime silence is expected.

## Enable / disable

| Control | Effect |
|---------|--------|
| **Ayarlar → Takip canlıları otomatik kaydet → Aç/Kapat** | Persists `storage/config/auto-follow-live.json` (`enabled`) |
| Env `AUTO_FOLLOW_LIVE=0` | Disables the background loop entirely (restart API) |
| Env `AUTO_FOLLOW_PROBE_BATCH` | Clamp **3–12** profile probes per slot (default **8**) |
| Sidebar **Durum** | Shows `Takip canlı: açık/kapalı` + currently watching + loud alert |

**Şimdi tara (kuru)** = dry-run poll (no new recordings; still hits IG — use sparingly after 429).

## Rate limits / politeness

- Only **3 IG scan windows per day** (Istanbul evenings).
- Prefer **reels_tray** over probing every profile every cycle.
- Profile probes: **700–1400 ms** between usernames; abort batch on **429**.
- On HTTP **429**, skip remaining retries for that slot; next attempt is the next evening window.
- Pause IG entirely while a capture is in progress.
- No private API kits / anti-bot bypass — operator cookies only.

## API

- `GET /api/settings/auto-follow-live` — includes `nextScanAt`, `scanWindowsTr`, `scanTimezone`, `scheduleHintTr`, `scanPaused`, …
- `PATCH /api/settings/auto-follow-live` `{ "enabled": true|false }`
- `POST /api/settings/auto-follow-live/poll-now` `{ "dryRun": true }` (default dry-run)
- `POST /api/recordings/live` `{ "input": "@user" }` — global single-flight
- `POST /api/recordings/:id/stop-live` — operator finalize + analysis
- `POST /api/recordings/cutover` `{ "input": "@user", "stopRecordingId"? }`

## Verify

```bash
cd ~/projects/mezatizle-evening-scan   # or deployed root
FORCE_MOCK_ASR=1 FORCE_MOCK_OCR=1 bun test tests/auto-follow-live.test.ts
curl -s http://127.0.0.1:43127/api/settings/auto-follow-live \
  | jq '{enabled,nextScanAt,scanWindowsTr,scanTimezone,scanPaused,healthOk,healthAlertTr}'
```

## Restart (do not kill active ffmpeg)

Prefer waiting until no `kaydediliyor`, or:

1. Note ffmpeg PID from `live_captures.process_pid` / `ps`.
2. Restart API only (`bash scripts/start-live.sh`) — ffmpeg is detached on new spawns.
3. Confirm ffmpeg PID still alive and `.part.mp4` growing.

**Do not** `pkill -f ffmpeg` while a live is recording.
