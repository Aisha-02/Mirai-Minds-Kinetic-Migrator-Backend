ALTER TABLE file_uploads
  ADD COLUMN IF NOT EXISTS parsed_data JSONB NOT NULL DEFAULT '[]'::jsonb;
