-- mezatizle Phase 1 schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sellers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'uploaded',
  duration_seconds DOUBLE PRECISION,
  width INTEGER,
  height INTEGER,
  video_codec TEXT,
  audio_codec TEXT,
  container TEXT,
  file_size_bytes BIGINT,
  notes TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recordings_status_chk CHECK (
    status IN ('uploaded', 'probing', 'ready', 'extracting', 'extracted', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_recordings_seller ON recordings(seller_id);
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress_percent INTEGER NOT NULL DEFAULT 0,
  stage TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_message TEXT,
  result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT processing_jobs_status_chk CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT processing_jobs_progress_chk CHECK (
    progress_percent >= 0 AND progress_percent <= 100
  )
);

CREATE INDEX IF NOT EXISTS idx_jobs_queue
  ON processing_jobs (status, available_at, priority, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_jobs_recording ON processing_jobs(recording_id);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence DOUBLE PRECISION,
  speaker TEXT,
  source TEXT NOT NULL DEFAULT 'asr',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcript_recording ON transcript_segments(recording_id);

CREATE TABLE IF NOT EXISTS observed_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ,
  offset_ms INTEGER,
  author_username TEXT,
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'operator_export',
  raw_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comments_recording ON observed_comments(recording_id);

CREATE TABLE IF NOT EXISTS auction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  offset_ms INTEGER,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auction_events_recording ON auction_events(recording_id);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  sku TEXT,
  title TEXT NOT NULL,
  description TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);

CREATE TABLE IF NOT EXISTS sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID REFERENCES recordings(id) ON DELETE SET NULL,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  buyer_username TEXT,
  amount_cents BIGINT,
  currency TEXT NOT NULL DEFAULT 'TRY',
  sold_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_seller ON sales(seller_id);
CREATE INDEX IF NOT EXISTS idx_sales_recording ON sales(recording_id);

CREATE TABLE IF NOT EXISTS sale_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,
  ref_table TEXT,
  ref_id UUID,
  note TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sale_evidence_sale ON sale_evidence(sale_id);

CREATE TABLE IF NOT EXISTS processing_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID REFERENCES recordings(id) ON DELETE CASCADE,
  job_id UUID REFERENCES processing_jobs(id) ON DELETE SET NULL,
  metric_name TEXT NOT NULL,
  metric_value DOUBLE PRECISION NOT NULL,
  unit TEXT,
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metrics_name ON processing_metrics(metric_name);

CREATE TABLE IF NOT EXISTS api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  units DOUBLE PRECISION NOT NULL DEFAULT 1,
  unit_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  recording_id UUID REFERENCES recordings(id) ON DELETE SET NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_usage_provider ON api_usage(provider, created_at);
