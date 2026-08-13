ALTER TABLE batches
  ADD COLUMN IF NOT EXISTS business_object TEXT,
  ADD COLUMN IF NOT EXISTS identifier_columns TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS schema_warnings JSONB,
  ADD COLUMN IF NOT EXISTS detection_confidence TEXT,
  ADD COLUMN IF NOT EXISTS detection_source TEXT,
  ADD COLUMN IF NOT EXISTS detection_reasoning TEXT;
