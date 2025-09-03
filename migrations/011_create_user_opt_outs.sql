-- Migration: Create user_opt_outs table for managing user preferences
-- Users can opt-out of automated messages by sending 'PARAR'

CREATE TABLE IF NOT EXISTS user_opt_outs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  opt_out_type TEXT NOT NULL DEFAULT 'all' CHECK (opt_out_type IN ('all', 'pre_visit', 'no_show_check')),
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Ensure one opt-out record per tenant/phone/type combination
  UNIQUE (tenant_id, phone_e164, opt_out_type)
);

-- Index for fast opt-out checks during message scheduling
CREATE INDEX IF NOT EXISTS idx_user_opt_outs_lookup 
  ON user_opt_outs (tenant_id, phone_e164, opt_out_type);

-- Index for tenant-specific analytics
CREATE INDEX IF NOT EXISTS idx_user_opt_outs_tenant 
  ON user_opt_outs (tenant_id, opted_out_at);

-- Index for time-based queries (opt-out trends)
CREATE INDEX IF NOT EXISTS idx_user_opt_outs_date 
  ON user_opt_outs (opted_out_at);

-- Comments for documentation
COMMENT ON TABLE user_opt_outs IS 'User preferences for automated messaging opt-outs';
COMMENT ON COLUMN user_opt_outs.opt_out_type IS 'Type of messages to opt-out from: all, pre_visit, or no_show_check';
COMMENT ON COLUMN user_opt_outs.opted_out_at IS 'When the user opted out (for analytics and compliance)';

-- Function to check if user has opted out of a specific message type
CREATE OR REPLACE FUNCTION is_user_opted_out(
  p_tenant_id TEXT,
  p_phone_e164 TEXT,
  p_message_type TEXT DEFAULT 'all'
) RETURNS BOOLEAN AS $$
BEGIN
  -- Check if user opted out of 'all' messages or the specific message type
  RETURN EXISTS (
    SELECT 1 FROM user_opt_outs 
    WHERE tenant_id = p_tenant_id 
      AND phone_e164 = p_phone_e164 
      AND opt_out_type IN ('all', p_message_type)
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION is_user_opted_out IS 'Check if user has opted out of automated messages for a specific type';