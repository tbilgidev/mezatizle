-- Video media retention: purge MP4/part/ASS/audio/raw frames after analysis ages,
-- keep DB analysis (sales, comments, transcript, product thumbs, KPIs).

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS media_purged_at TIMESTAMPTZ;

COMMENT ON COLUMN recordings.media_purged_at IS
  'When master video (+ derived audio/frames/ASS) were deleted by retention; analysis rows remain.';

CREATE INDEX IF NOT EXISTS idx_recordings_media_purge_candidates
  ON recordings (updated_at)
  WHERE media_purged_at IS NULL
    AND status IN ('complete', 'failed', 'cancelled');
