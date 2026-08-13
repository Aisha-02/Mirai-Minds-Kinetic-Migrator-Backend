-- Batches group a preload+postload pair (and their comparison report).
-- Required so file_uploads.batch_id and comparison_reports.batch_id can be real FKs.
CREATE TABLE IF NOT EXISTS batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS batches_user_id_idx ON batches (user_id);

CREATE TYPE file_upload_type AS ENUM ('preload', 'postload');

CREATE TABLE IF NOT EXISTS file_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
  file_type file_upload_type NOT NULL,
  original_filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT file_uploads_batch_file_type_unique UNIQUE (batch_id, file_type)
);

CREATE INDEX IF NOT EXISTS file_uploads_batch_id_idx ON file_uploads (batch_id);
CREATE INDEX IF NOT EXISTS file_uploads_user_id_idx ON file_uploads (user_id);

CREATE TYPE comparison_report_status AS ENUM (
  'pending',
  'processing',
  'completed',
  'failed'
);

CREATE TABLE IF NOT EXISTS comparison_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
  status comparison_report_status NOT NULL DEFAULT 'pending',
  summary_json JSONB,
  ai_report_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  CONSTRAINT comparison_reports_batch_id_unique UNIQUE (batch_id)
);

CREATE INDEX IF NOT EXISTS comparison_reports_batch_id_idx ON comparison_reports (batch_id);
CREATE INDEX IF NOT EXISTS comparison_reports_status_idx ON comparison_reports (status);
