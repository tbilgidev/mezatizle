# Analysis job watchdog

User systemd timer `mezatizle-analysis-watchdog.timer` runs `scripts/analysis-watchdog.sh` every **5 minutes**.

## What it does

1. Kills orphan `tools.py` ASR/OCR processes (PPID=1 only).
2. **Salvages** stuck `transcribe` jobs when a near-full transcript already exists (marks succeeded — does not re-run ASR, so segments are not deleted).
3. **Reclaims** other `running` jobs whose heartbeat (`locked_at` / `updated_at`) is older than `ANALYSIS_JOB_STALE_MINUTES` (default **5**) **and** no live `tools.py` child exists for that recording.
4. Tracks a progress fingerprint (`logs/analysis-watchdog.state`); if `%` + stage are unchanged for 5 minutes with no live child, reclaims.
5. Ensures `mezatizle-analysis-drain.service` is up when work remains.

## What it does not do

- Restart the API
- Start or stop live capture / ffmpeg
- Delete comments, transcripts, or recordings

## Related units

| Unit | Role |
|------|------|
| `mezatizle-analysis-watchdog.timer` / `.service` | This watchdog |
| `mezatizle-analysis-drain.service` | Secondary analysis worker |
| `mezatizle-api-watchdog.timer` | API health (separate) |
| `mezatizle-capture-stall-watchdog.timer` | Live capture stall (separate) |

## Env

- `ANALYSIS_JOB_STALE_MINUTES` (default 5)
- `ANALYSIS_PROGRESS_STALE_MINUTES` (default = stale minutes)
