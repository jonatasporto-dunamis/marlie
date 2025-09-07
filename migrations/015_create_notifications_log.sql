-- Migration: Create notifications_log table for deduplication system
-- Date: 2024-01-XX
-- Description: Unified notification logging and deduplication system

CREATE TABLE IF NOT EXISTS notifications_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  phone TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('previsit', 'noshow_yes', 'noshow_no', 'rebook', 'audit')),
  payload JSONB NOT NULL DEFAULT '{}',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Unique constraint for deduplication
  UNIQUE (tenant_id, dedupe_key)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_notifications_log_tenant_dedupe 
  ON notifications_log (tenant_id, dedupe_key);

CREATE INDEX IF NOT EXISTS idx_notifications_log_tenant_phone 
  ON notifications_log (tenant_id, phone);

CREATE INDEX IF NOT EXISTS idx_notifications_log_kind 
  ON notifications_log (kind, sent_at);

CREATE INDEX IF NOT EXISTS idx_notifications_log_sent_at 
  ON notifications_log (sent_at);

-- Index for cleanup operations
CREATE INDEX IF NOT EXISTS idx_notifications_log_cleanup 
  ON notifications_log (created_at) WHERE created_at < now() - INTERVAL '90 days';

-- Comments for documentation
COMMENT ON TABLE notifications_log IS 'Unified notification logging and deduplication system';
COMMENT ON COLUMN notifications_log.dedupe_key IS 'Unique key for deduplication (e.g., previsit:appointment_id:date)';
COMMENT ON COLUMN notifications_log.kind IS 'Type of notification: previsit, noshow_yes, noshow_no, rebook, audit';
COMMENT ON COLUMN notifications_log.payload IS 'Additional data related to the notification';
COMMENT ON COLUMN notifications_log.sent_at IS 'When the notification was actually sent';

-- Function to generate dedupe keys
CREATE OR REPLACE FUNCTION generate_dedupe_key(
  notification_type TEXT,
  appointment_id TEXT,
  additional_data TEXT DEFAULT NULL
) RETURNS TEXT AS $$
BEGIN
  IF additional_data IS NOT NULL THEN
    RETURN notification_type || ':' || appointment_id || ':' || additional_data;
  ELSE
    RETURN notification_type || ':' || appointment_id;
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to check if notification already exists (for deduplication)
CREATE OR REPLACE FUNCTION notification_exists(
  p_tenant_id TEXT,
  p_dedupe_key TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM notifications_log 
    WHERE tenant_id = p_tenant_id AND dedupe_key = p_dedupe_key
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to log notification with automatic deduplication
CREATE OR REPLACE FUNCTION log_notification(
  p_tenant_id TEXT,
  p_dedupe_key TEXT,
  p_phone TEXT,
  p_kind TEXT,
  p_payload JSONB DEFAULT '{}'
) RETURNS UUID AS $$
DECLARE
  notification_id UUID;
BEGIN
  -- Try to insert, ignore if duplicate
  INSERT INTO notifications_log (tenant_id, dedupe_key, phone, kind, payload)
  VALUES (p_tenant_id, p_dedupe_key, p_phone, p_kind, p_payload)
  ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
  RETURNING id INTO notification_id;
  
  RETURN notification_id;
END;
$$ LANGUAGE plpgsql;

-- Function for cleanup old notifications
CREATE OR REPLACE FUNCTION cleanup_old_notifications(
  days_to_keep INTEGER DEFAULT 90
) RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM notifications_log 
  WHERE created_at < now() - (days_to_keep || ' days')::INTERVAL;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- View for notification statistics
CREATE OR REPLACE VIEW notification_stats_daily AS
SELECT 
  tenant_id,
  kind,
  DATE(sent_at) as date,
  COUNT(*) as total_sent,
  COUNT(DISTINCT phone) as unique_recipients
FROM notifications_log
WHERE sent_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY tenant_id, kind, DATE(sent_at)
ORDER BY date DESC, tenant_id, kind;

-- View for deduplication statistics
CREATE OR REPLACE VIEW deduplication_stats AS
SELECT 
  tenant_id,
  kind,
  DATE(created_at) as date,
  COUNT(*) as total_attempts,
  COUNT(CASE WHEN sent_at IS NOT NULL THEN 1 END) as successful_sends,
  COUNT(*) - COUNT(CASE WHEN sent_at IS NOT NULL THEN 1 END) as duplicates_blocked
FROM notifications_log
WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY tenant_id, kind, DATE(created_at)
ORDER BY date DESC, tenant_id, kind;

COMMENT ON VIEW notification_stats_daily IS 'Daily notification statistics by tenant and type';
COMMENT ON VIEW deduplication_stats IS 'Deduplication effectiveness statistics';

-- Enable Row Level Security
ALTER TABLE notifications_log ENABLE ROW LEVEL SECURITY;

-- RLS Policy for tenant isolation
CREATE POLICY notifications_log_tenant_isolation ON notifications_log
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));