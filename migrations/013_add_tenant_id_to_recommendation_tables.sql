-- Migration: Add tenant_id to recommendation tables for multi-tenant support
-- Date: 2024-01-XX
-- Description: P0.1 - Add tenant_id column to all recommendation tables and update constraints

-- Add tenant_id column to user_time_preferences
ALTER TABLE user_time_preferences 
ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Drop old unique constraint and create new one with tenant_id
ALTER TABLE user_time_preferences 
DROP CONSTRAINT IF EXISTS user_time_preferences_phone_number_time_slot_key;

ALTER TABLE user_time_preferences 
ADD CONSTRAINT user_time_preferences_tenant_phone_time_unique 
UNIQUE (tenant_id, phone_number, time_slot);

-- Add tenant_id column to user_service_preferences
ALTER TABLE user_service_preferences 
ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Drop old unique constraint and create new one with tenant_id
ALTER TABLE user_service_preferences 
DROP CONSTRAINT IF EXISTS user_service_preferences_phone_number_service_name_key;

ALTER TABLE user_service_preferences 
ADD CONSTRAINT user_service_preferences_tenant_phone_service_unique 
UNIQUE (tenant_id, phone_number, service_name);

-- Add tenant_id column to user_professional_preferences
ALTER TABLE user_professional_preferences 
ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Drop old unique constraint and create new one with tenant_id
ALTER TABLE user_professional_preferences 
DROP CONSTRAINT IF EXISTS user_professional_preferences_phone_number_professional_name_key;

ALTER TABLE user_professional_preferences 
ADD CONSTRAINT user_professional_preferences_tenant_phone_prof_unique 
UNIQUE (tenant_id, phone_number, professional_name);

-- Add tenant_id column to post_booking_interactions
ALTER TABLE post_booking_interactions 
ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Add tenant_id column to upsell_tracking
ALTER TABLE upsell_tracking 
ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Add tenant_id column to pre_visit_messages
ALTER TABLE pre_visit_messages 
ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Add tenant_id column to booking_metrics
ALTER TABLE booking_metrics 
ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Add tenant_id column to ab_test_assignments
ALTER TABLE ab_test_assignments 
ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Drop old unique constraint and create new one with tenant_id
ALTER TABLE ab_test_assignments 
DROP CONSTRAINT IF EXISTS ab_test_assignments_phone_number_test_name_key;

ALTER TABLE ab_test_assignments 
ADD CONSTRAINT ab_test_assignments_tenant_phone_test_unique 
UNIQUE (tenant_id, phone_number, test_name);

-- Create indexes for performance with tenant_id
CREATE INDEX IF NOT EXISTS idx_user_time_preferences_tenant_phone 
  ON user_time_preferences (tenant_id, phone_number);

CREATE INDEX IF NOT EXISTS idx_user_service_preferences_tenant_phone 
  ON user_service_preferences (tenant_id, phone_number);

CREATE INDEX IF NOT EXISTS idx_user_professional_preferences_tenant_phone 
  ON user_professional_preferences (tenant_id, phone_number);

CREATE INDEX IF NOT EXISTS idx_post_booking_interactions_tenant_phone 
  ON post_booking_interactions (tenant_id, phone_number);

CREATE INDEX IF NOT EXISTS idx_upsell_tracking_tenant_phone 
  ON upsell_tracking (tenant_id, phone_number);

CREATE INDEX IF NOT EXISTS idx_pre_visit_messages_tenant_phone 
  ON pre_visit_messages (tenant_id, phone_number);

CREATE INDEX IF NOT EXISTS idx_booking_metrics_tenant_phone 
  ON booking_metrics (tenant_id, phone_number);

CREATE INDEX IF NOT EXISTS idx_ab_test_assignments_tenant_phone 
  ON ab_test_assignments (tenant_id, phone_number);

-- Create composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_user_time_preferences_tenant_freq 
  ON user_time_preferences (tenant_id, frequency DESC, last_used DESC);

CREATE INDEX IF NOT EXISTS idx_user_service_preferences_tenant_freq 
  ON user_service_preferences (tenant_id, frequency DESC, last_used DESC);

CREATE INDEX IF NOT EXISTS idx_user_professional_preferences_tenant_freq 
  ON user_professional_preferences (tenant_id, frequency DESC, last_used DESC);

CREATE INDEX IF NOT EXISTS idx_post_booking_interactions_tenant_type 
  ON post_booking_interactions (tenant_id, interaction_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_upsell_tracking_tenant_accepted 
  ON upsell_tracking (tenant_id, accepted, offered_at DESC);

CREATE INDEX IF NOT EXISTS idx_pre_visit_messages_tenant_status 
  ON pre_visit_messages (tenant_id, status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_booking_metrics_tenant_first_try 
  ON booking_metrics (tenant_id, first_try_booking, created_at DESC);

-- Enable RLS on all recommendation tables
ALTER TABLE user_time_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_service_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_professional_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_booking_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE upsell_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE pre_visit_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE ab_test_assignments ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for tenant isolation
CREATE POLICY user_time_preferences_isolation ON user_time_preferences
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY user_service_preferences_isolation ON user_service_preferences
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY user_professional_preferences_isolation ON user_professional_preferences
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY post_booking_interactions_isolation ON post_booking_interactions
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY upsell_tracking_isolation ON upsell_tracking
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY pre_visit_messages_isolation ON pre_visit_messages
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY booking_metrics_isolation ON booking_metrics
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY ab_test_assignments_isolation ON ab_test_assignments
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Comments for documentation
COMMENT ON COLUMN user_time_preferences.tenant_id IS 'Tenant identifier for multi-tenant isolation';
COMMENT ON COLUMN user_service_preferences.tenant_id IS 'Tenant identifier for multi-tenant isolation';
COMMENT ON COLUMN user_professional_preferences.tenant_id IS 'Tenant identifier for multi-tenant isolation';
COMMENT ON COLUMN post_booking_interactions.tenant_id IS 'Tenant identifier for multi-tenant isolation';
COMMENT ON COLUMN upsell_tracking.tenant_id IS 'Tenant identifier for multi-tenant isolation';
COMMENT ON COLUMN pre_visit_messages.tenant_id IS 'Tenant identifier for multi-tenant isolation';
COMMENT ON COLUMN booking_metrics.tenant_id IS 'Tenant identifier for multi-tenant isolation';
COMMENT ON COLUMN ab_test_assignments.tenant_id IS 'Tenant identifier for multi-tenant isolation';

COMMIT;