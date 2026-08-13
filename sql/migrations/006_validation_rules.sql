-- Field-wise AI validation rules (Business Object → Field → AI rules)
-- Does not store uploaded Excel payloads.

CREATE TABLE IF NOT EXISTS validation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_object TEXT NOT NULL,
  rules JSONB NOT NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT validation_rules_business_object_check
    CHECK (business_object IN ('MM', 'PO', 'GL Account', 'BP'))
);

CREATE INDEX IF NOT EXISTS validation_rules_business_object_idx
  ON validation_rules (business_object);

CREATE INDEX IF NOT EXISTS validation_rules_created_at_idx
  ON validation_rules (created_at DESC);

-- If an older local table still has source_fields, drop it safely
ALTER TABLE validation_rules DROP COLUMN IF EXISTS source_fields;
