-- Validation cleanup sessions: preload data + report + pending fix proposals

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
