-- Live capture sessions + extended recording statuses

ALTER TABLE recordings DROP CONSTRAINT IF EXISTS recordings_status_chk;
ALTER TABLE recordings ADD CONSTRAINT recordings_status_chk CHECK (
  status IN (
    'awaiting_live',
    'recording',
    'uploaded',
    'probing',
    'ready',
    'extracting',
    'extracted',
    'transcribing',
    'analyzing',
    'complete',
    'failed',
    'cancelled'
  )
);

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'upload',
  ADD COLUMN IF NOT EXISTS source_input TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS capture_status TEXT,
  ADD COLUMN IF NOT EXISTS capture_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capture_ended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capture_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capture_error TEXT;

ALTER TABLE recordings DROP CONSTRAINT IF EXISTS recordings_source_type_chk;
ALTER TABLE recordings ADD CONSTRAINT recordings_source_type_chk CHECK (
  source_type IN ('upload', 'live')
);

ALTER TABLE recordings DROP CONSTRAINT IF EXISTS recordings_capture_status_chk;
ALTER TABLE recordings ADD CONSTRAINT recordings_capture_status_chk CHECK (
  capture_status IS NULL OR capture_status IN (
    'bekleniyor',
    'kaydediliyor',
    'bitti',
    'bulunamadi',
    'engellendi',
    'iptal',
    'hata'
  )
);

CREATE TABLE IF NOT EXISTS live_captures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID NOT NULL UNIQUE REFERENCES recordings(id) ON DELETE CASCADE,
  input_raw TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  resolved_username TEXT,
  watch_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_probe_at TIMESTAMPTZ,
  last_probe_detail TEXT,
  process_pid INTEGER,
  max_bytes BIGINT NOT NULL DEFAULT 2147483648,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT live_captures_source_kind_chk CHECK (
    source_kind IN ('live_url', 'profile_url', 'username')
  ),
  CONSTRAINT live_captures_status_chk CHECK (
    status IN (
      'pending',
      'waiting',
      'recording',
      'finalizing',
      'completed',
      'not_found',
      'blocked',
      'failed',
      'cancelled'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_live_captures_status ON live_captures (status)
  WHERE status IN ('pending', 'waiting', 'recording', 'finalizing');
