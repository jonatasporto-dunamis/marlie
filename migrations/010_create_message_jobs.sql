-- Migration: Create message_jobs table for scheduling pre-visit and no-show messages
-- This table implements a simple job scheduler for automated messaging

CREATE TABLE IF NOT EXISTS message_jobs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pre_visit', 'no_show_check')),
  run_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'canceled')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for efficient job processing (find pending jobs due for execution)
CREATE INDEX IF NOT EXISTS idx_message_jobs_due 
  ON message_jobs (status, run_at) 
  WHERE status = 'pending';

-- Index for tenant-specific queries
CREATE INDEX IF NOT EXISTS idx_message_jobs_tenant 
  ON message_jobs (tenant_id, phone_e164);

-- Index for job kind filtering
CREATE INDEX IF NOT EXISTS idx_message_jobs_kind 
  ON message_jobs (kind, status);

-- Trigger to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_message_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_message_jobs_updated_at
  BEFORE UPDATE ON message_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_message_jobs_updated_at();

-- Comments for documentation
COMMENT ON TABLE message_jobs IS 'Job scheduler for automated messaging (pre-visit reminders and no-show prevention)';
COMMENT ON COLUMN message_jobs.kind IS 'Type of message: pre_visit (24-40h before) or no_show_check (D-1 at 18:00)';
COMMENT ON COLUMN message_jobs.run_at IS 'When to execute this job (timezone-aware)';
COMMENT ON COLUMN message_jobs.payload IS 'Job-specific data (booking details, message content, etc.)';
COMMENT ON COLUMN message_jobs.status IS 'Job execution status: pending, sent, failed, or canceled';
COMMENT ON COLUMN message_jobs.attempts IS 'Number of execution attempts (for retry logic with backoff)';
COMMENT ON COLUMN message_jobs.last_error IS 'Last error message if job failed';