-- Admin workspace: source schema uploads, cached mappings, rules drafts, active pointer

CREATE TABLE IF NOT EXISTS admin_source_schemas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  source_fields JSONB NOT NULL,
  s3_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_source_schemas_user_hash_idx
  ON admin_source_schemas (created_by, file_hash);

CREATE TABLE IF NOT EXISTS admin_schema_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_schema_id UUID NOT NULL REFERENCES admin_source_schemas (id) ON DELETE CASCADE,
  business_object TEXT NOT NULL,
  sap_business_object TEXT NOT NULL,
  mappings JSONB NOT NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_schema_mappings_schema_bo_unique UNIQUE (source_schema_id, business_object)
);

CREATE INDEX IF NOT EXISTS admin_schema_mappings_schema_idx
  ON admin_schema_mappings (source_schema_id);

CREATE TABLE IF NOT EXISTS admin_rules_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_schema_id UUID NOT NULL REFERENCES admin_source_schemas (id) ON DELETE CASCADE,
  business_object TEXT NOT NULL,
  rules JSONB NOT NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_rules_drafts_schema_bo_unique UNIQUE (source_schema_id, business_object)
);

CREATE INDEX IF NOT EXISTS admin_rules_drafts_schema_idx
  ON admin_rules_drafts (source_schema_id);

CREATE TABLE IF NOT EXISTS admin_workspace_state (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  active_source_schema_id UUID REFERENCES admin_source_schemas (id) ON DELETE SET NULL,
  selected_business_object TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
