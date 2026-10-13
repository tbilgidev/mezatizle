-- Optional hard-stop duration for live capture (NULL/0 = entire live)
ALTER TABLE live_captures
  ADD COLUMN IF NOT EXISTS max_duration_minutes INTEGER;

ALTER TABLE live_captures DROP CONSTRAINT IF EXISTS live_captures_max_duration_chk;
ALTER TABLE live_captures ADD CONSTRAINT live_captures_max_duration_chk CHECK (
  max_duration_minutes IS NULL
  OR (max_duration_minutes >= 0 AND max_duration_minutes <= 24 * 60)
);
