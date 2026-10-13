ALTER TABLE recordings DROP CONSTRAINT IF EXISTS recordings_status_chk;
ALTER TABLE recordings ADD CONSTRAINT recordings_status_chk CHECK (
  status IN (
    'uploaded', 'probing', 'ready', 'extracting', 'extracted',
    'transcribing', 'analyzing', 'complete', 'failed'
  )
);
