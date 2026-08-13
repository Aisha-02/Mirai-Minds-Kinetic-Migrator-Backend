-- S3 file key columns for generated artifacts.
-- Note: file_uploads.storage_path and transformation_documents.storage_path
-- now store S3 object keys (not local filesystem paths).

ALTER TABLE comparison_reports
  ADD COLUMN IF NOT EXISTS pdf_s3_key TEXT;

ALTER TABLE admin_schema_mappings
  ADD COLUMN IF NOT EXISTS output_s3_key TEXT;

ALTER TABLE admin_rules_drafts
  ADD COLUMN IF NOT EXISTS output_s3_key TEXT;

ALTER TABLE validation_cleanup_sessions
  ADD COLUMN IF NOT EXISTS refined_s3_key TEXT,
  ADD COLUMN IF NOT EXISTS refined_filename TEXT;
