-- Reference snapshot of the full schema after all migrations.
-- Do not apply this file directly — use: npm run db:migrate
-- Source of truth: sql/migrations/*.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TYPE user_role AS ENUM ('admin', 'normal_user');

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'normal_user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);

CREATE TABLE IF NOT EXISTS batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_object TEXT,
  identifier_columns TEXT[] NOT NULL DEFAULT '{}',
  schema_warnings JSONB,
  detection_confidence TEXT,
  detection_source TEXT,
  detection_reasoning TEXT
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
  parsed_data JSONB NOT NULL DEFAULT '[]'::jsonb,
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

CREATE TABLE IF NOT EXISTS validation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_object TEXT NOT NULL,
  rules JSONB NOT NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT validation_rules_business_object_check
    CHECK (business_object IN ('MM', 'PO', 'GL Account', 'BP', 'SO'))
);

CREATE INDEX IF NOT EXISTS validation_rules_business_object_idx
  ON validation_rules (business_object);

CREATE INDEX IF NOT EXISTS validation_rules_created_at_idx
  ON validation_rules (created_at DESC);

CREATE TABLE IF NOT EXISTS validation_cleanup_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  business_object TEXT NOT NULL,
  detector_label TEXT,
  detection JSONB,
  rule_set_id UUID REFERENCES validation_rules (id) ON DELETE SET NULL,
  rules_snapshot JSONB NOT NULL,
  original_data JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_data JSONB NOT NULL DEFAULT '[]'::jsonb,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  report JSONB,
  summary JSONB,
  pending_proposal JSONB,
  chat_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS validation_cleanup_sessions_user_id_idx
  ON validation_cleanup_sessions (user_id);

CREATE INDEX IF NOT EXISTS validation_cleanup_sessions_created_at_idx
  ON validation_cleanup_sessions (created_at DESC);
