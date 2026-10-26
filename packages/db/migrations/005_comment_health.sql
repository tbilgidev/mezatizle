-- Comment capture health for live recordings (drought / viewer failure).

ALTER TABLE live_captures
  ADD COLUMN IF NOT EXISTS comments_warning TEXT;

COMMENT ON COLUMN live_captures.comments_warning IS
  'Operator-facing warning when live_api comments stay empty while kaydediliyor (e.g. Yorum yok).';
