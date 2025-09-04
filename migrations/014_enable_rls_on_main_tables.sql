-- Migration: Enable Row Level Security (RLS) on main business tables
-- Date: 2024-01-XX
-- Description: P0.1 - Enable RLS and create tenant isolation policies for all main tables

-- Enable RLS on main business tables that already have tenant_id
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE servicos_prof ENABLE ROW LEVEL SECURITY;
ALTER TABLE pre_visit_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE no_show_shield_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_no_show_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE upsell_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_opt_outs ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for tenant isolation on main tables
-- Policy for contacts table
CREATE POLICY contacts_tenant_isolation ON contacts
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for conversation_states table
CREATE POLICY conversation_states_tenant_isolation ON conversation_states
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for appointment_requests table
CREATE POLICY appointment_requests_tenant_isolation ON appointment_requests
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for client_sessions table
CREATE POLICY client_sessions_tenant_isolation ON client_sessions
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for servicos_prof table
CREATE POLICY servicos_prof_tenant_isolation ON servicos_prof
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for pre_visit_notifications table
CREATE POLICY pre_visit_notifications_tenant_isolation ON pre_visit_notifications
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for appointment_history table
CREATE POLICY appointment_history_tenant_isolation ON appointment_history
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for no_show_shield_config table
CREATE POLICY no_show_shield_config_tenant_isolation ON no_show_shield_config
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for client_no_show_tracking table
CREATE POLICY client_no_show_tracking_tenant_isolation ON client_no_show_tracking
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for upsell_events table
CREATE POLICY upsell_events_tenant_isolation ON upsell_events
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for user_prefs table
CREATE POLICY user_prefs_tenant_isolation ON user_prefs
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for message_jobs table
CREATE POLICY message_jobs_tenant_isolation ON message_jobs
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Policy for user_opt_outs table
CREATE POLICY user_opt_outs_tenant_isolation ON user_opt_outs
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Create additional composite indexes for RLS performance
-- These indexes help PostgreSQL optimize RLS policy checks
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_rls 
  ON contacts (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_states_tenant_rls 
  ON conversation_states (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appointment_requests_tenant_rls 
  ON appointment_requests (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_client_sessions_tenant_rls 
  ON client_sessions (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_servicos_prof_tenant_rls 
  ON servicos_prof (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pre_visit_notifications_tenant_rls 
  ON pre_visit_notifications (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appointment_history_tenant_rls 
  ON appointment_history (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_no_show_shield_config_tenant_rls 
  ON no_show_shield_config (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_client_no_show_tracking_tenant_rls 
  ON client_no_show_tracking (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_upsell_events_tenant_rls 
  ON upsell_events (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_prefs_tenant_rls 
  ON user_prefs (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_jobs_tenant_rls 
  ON message_jobs (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_opt_outs_tenant_rls 
  ON user_opt_outs (tenant_id) WHERE tenant_id IS NOT NULL;

-- Create function to validate tenant_id setting
CREATE OR REPLACE FUNCTION validate_tenant_context()
RETURNS BOOLEAN AS $$
BEGIN
  -- Check if app.tenant_id is set and not empty
  RETURN current_setting('app.tenant_id', true) IS NOT NULL 
    AND current_setting('app.tenant_id', true) != '';
EXCEPTION
  WHEN OTHERS THEN
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to get current tenant_id safely
CREATE OR REPLACE FUNCTION get_current_tenant_id()
RETURNS TEXT AS $$
BEGIN
  RETURN current_setting('app.tenant_id', true);
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Comments for documentation
COMMENT ON FUNCTION validate_tenant_context() IS 'Validates that app.tenant_id is properly set for RLS';
COMMENT ON FUNCTION get_current_tenant_id() IS 'Safely retrieves current tenant_id from session setting';

-- Create view to check RLS status across all tables
CREATE OR REPLACE VIEW rls_status AS
SELECT 
  schemaname,
  tablename,
  rowsecurity as rls_enabled,
  CASE 
    WHEN rowsecurity THEN 'Enabled'
    ELSE 'Disabled'
  END as status
FROM pg_tables 
WHERE schemaname = 'public'
  AND tablename IN (
    'contacts', 'conversation_states', 'appointment_requests', 'client_sessions',
    'servicos_prof', 'pre_visit_notifications', 'appointment_history', 
    'no_show_shield_config', 'client_no_show_tracking', 'upsell_events',
    'user_prefs', 'message_jobs', 'user_opt_outs', 'tenant_configs',
    'user_time_preferences', 'user_service_preferences', 'user_professional_preferences',
    'post_booking_interactions', 'upsell_tracking', 'pre_visit_messages',
    'booking_metrics', 'ab_test_assignments'
  )
ORDER BY tablename;

COMMENT ON VIEW rls_status IS 'Shows RLS status for all multi-tenant tables';

COMMIT;