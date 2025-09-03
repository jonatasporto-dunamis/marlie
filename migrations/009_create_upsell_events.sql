-- Migration: Create upsell_events table for tracking upsell offers
-- Purpose: Track upsell suggestions, acceptances, and declines for revenue optimization
-- Date: 2024-01-XX

CREATE TABLE IF NOT EXISTS upsell_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  booking_id TEXT,
  base_service_id BIGINT NOT NULL,
  suggested_service_id BIGINT NOT NULL,
  suggested_price_cents INT,
  shown_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  source TEXT DEFAULT 'contextual', -- regra aplicada
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Constraint to prevent duplicate suggestions for same booking
  UNIQUE (tenant_id, phone_e164, booking_id, suggested_service_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_upsell_events_tenant_phone 
  ON upsell_events (tenant_id, phone_e164);

CREATE INDEX IF NOT EXISTS idx_upsell_events_booking 
  ON upsell_events (booking_id) WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_upsell_events_shown_at 
  ON upsell_events (shown_at);

CREATE INDEX IF NOT EXISTS idx_upsell_events_accepted 
  ON upsell_events (accepted_at) WHERE accepted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_upsell_events_declined 
  ON upsell_events (declined_at) WHERE declined_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_upsell_events_source 
  ON upsell_events (source);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_upsell_events_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_upsell_events_updated_at
  BEFORE UPDATE ON upsell_events
  FOR EACH ROW
  EXECUTE FUNCTION update_upsell_events_updated_at();

-- Comments for documentation
COMMENT ON TABLE upsell_events IS 'Tracks upsell suggestions and user responses for revenue optimization';
COMMENT ON COLUMN upsell_events.tenant_id IS 'Tenant identifier';
COMMENT ON COLUMN upsell_events.phone_e164 IS 'User phone number in E.164 format';
COMMENT ON COLUMN upsell_events.booking_id IS 'Associated booking ID (nullable for conversation-level tracking)';
COMMENT ON COLUMN upsell_events.base_service_id IS 'Original service being booked';
COMMENT ON COLUMN upsell_events.suggested_service_id IS 'Suggested additional service';
COMMENT ON COLUMN upsell_events.suggested_price_cents IS 'Price of suggested service in cents';
COMMENT ON COLUMN upsell_events.shown_at IS 'When the upsell was shown to user';
COMMENT ON COLUMN upsell_events.accepted_at IS 'When user accepted the upsell (NULL if not accepted)';
COMMENT ON COLUMN upsell_events.declined_at IS 'When user declined the upsell (NULL if not declined)';
COMMENT ON COLUMN upsell_events.source IS 'Rule or context that triggered the upsell suggestion';

-- Validation constraints
ALTER TABLE upsell_events ADD CONSTRAINT check_upsell_price_positive 
  CHECK (suggested_price_cents IS NULL OR suggested_price_cents > 0);

ALTER TABLE upsell_events ADD CONSTRAINT check_upsell_response_exclusive 
  CHECK (
    (accepted_at IS NULL AND declined_at IS NULL) OR
    (accepted_at IS NOT NULL AND declined_at IS NULL) OR
    (accepted_at IS NULL AND declined_at IS NOT NULL)
  );

ALTER TABLE upsell_events ADD CONSTRAINT check_upsell_response_after_shown 
  CHECK (
    (accepted_at IS NULL OR accepted_at >= shown_at) AND
    (declined_at IS NULL OR declined_at >= shown_at)
  );

-- Grant permissions (adjust as needed for your setup)
-- GRANT SELECT, INSERT, UPDATE ON upsell_events TO app_user;
-- GRANT USAGE ON SEQUENCE upsell_events_id_seq TO app_user;