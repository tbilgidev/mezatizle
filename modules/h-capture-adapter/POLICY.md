# Capture policy (Module H)

Live capture via **yt-dlp + ffmpeg** on the operator machine.

## Allowed
- Operator pastes a public Instagram Live URL, profile URL, or `@username`
- Operator-provided **backup account session** under Ayarlar → Instagram oturumu:
  - Netscape cookies.txt (preferred) → `yt-dlp --cookies`
  - Optional username/password stored encrypted in `storage/secrets/` (never re-sent to UI)
- Record to `storage/recordings/<id>.mp4` when the stream resolves
- Auto-stop when the live ends → enqueue analysis pipeline
- Manual MP4 upload as advanced fallback

## Forbidden
- Private or undocumented Instagram APIs
- Anti-bot circumvention / CAPTCHA bypass kits
- Using someone else’s account without authorization

## Limitation
Instagram may still challenge or block even with cookies. Operator is responsible
for consent/compliance. Secrets must not be logged.
