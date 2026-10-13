# Capture policy (Module H)

Public-stream capture only via **yt-dlp + ffmpeg** on the operator machine.

## Allowed
- Operator pastes a public Instagram Live URL, profile URL, or `@username`
- Resolve/monitor with yt-dlp (no login cookies injected by mezatizle)
- Record to `storage/recordings/<id>.mp4` when a public stream URL is obtainable
- Auto-stop when the live ends (yt-dlp/ffmpeg exit) → enqueue analysis pipeline
- Manual MP4 upload remains as advanced fallback

## Forbidden
- Instagram login / credential stuffing
- Private or undocumented Instagram APIs
- Anti-bot circumvention / CAPTCHA bypass
- Playwright credentialed sessions

## Limitation
Instagram often requires login for live playback. When blocked, the UI shows
**yayın bulunamadı / erişim engellendi** and keeps retrying until timeout or cancel.
