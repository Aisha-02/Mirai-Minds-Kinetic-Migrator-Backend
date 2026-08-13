CREATE TABLE IF NOT EXISTS transformation_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  file_size BIGINT,
  uploaded_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transformation_documents_category_idx
  ON transformation_documents (category);

CREATE INDEX IF NOT EXISTS transformation_documents_created_at_idx
  ON transformation_documents (created_at DESC);
