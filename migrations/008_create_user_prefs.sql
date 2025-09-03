-- Migration: Create user_prefs table for storing user preferences
-- This table stores user preferences by phone number for personalized recommendations

CREATE TABLE IF NOT EXISTS user_prefs (
    phone_e164 VARCHAR(20) PRIMARY KEY,
    tenant_id VARCHAR(50) NOT NULL DEFAULT 'default',
    
    -- Professional preference (ID from Trinks API)
    professional_id_pref VARCHAR(50),
    
    -- Time slot window preferences (morning, afternoon, evening)
    slot_window_pref VARCHAR(20) CHECK (slot_window_pref IN ('morning', 'afternoon', 'evening')),
    
    -- Top services as JSONB array with usage count
    -- Format: [{"service_id": "123", "service_name": "Corte", "count": 5}, ...]
    service_top JSONB DEFAULT '[]'::jsonb,
    
    -- Booking history stats for popularity ranking
    total_bookings INTEGER DEFAULT 0,
    successful_bookings INTEGER DEFAULT 0,
    
    -- Preferred days of week (0=Sunday, 6=Saturday)
    preferred_days INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    
    -- Preferred time ranges (24h format)
    preferred_start_time TIME DEFAULT '09:00',
    preferred_end_time TIME DEFAULT '18:00',
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_prefs_tenant ON user_prefs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_prefs_professional ON user_prefs(professional_id_pref) WHERE professional_id_pref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_prefs_window ON user_prefs(slot_window_pref) WHERE slot_window_pref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_prefs_updated ON user_prefs(updated_at);

-- GIN index for JSONB service_top queries
CREATE INDEX IF NOT EXISTS idx_user_prefs_service_top ON user_prefs USING GIN(service_top);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_user_prefs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update updated_at
DROP TRIGGER IF EXISTS trigger_user_prefs_updated_at ON user_prefs;
CREATE TRIGGER trigger_user_prefs_updated_at
    BEFORE UPDATE ON user_prefs
    FOR EACH ROW
    EXECUTE FUNCTION update_user_prefs_updated_at();

-- Create table for global slot popularity (fallback ranking)
CREATE TABLE IF NOT EXISTS slot_popularity (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(50) NOT NULL DEFAULT 'default',
    service_id VARCHAR(50),
    professional_id VARCHAR(50),
    day_of_week INTEGER CHECK (day_of_week >= 0 AND day_of_week <= 6),
    hour_slot INTEGER CHECK (hour_slot >= 0 AND hour_slot <= 23),
    booking_count INTEGER DEFAULT 0,
    success_rate DECIMAL(5,4) DEFAULT 0.0000,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(tenant_id, service_id, professional_id, day_of_week, hour_slot)
);

-- Indexes for slot_popularity
CREATE INDEX IF NOT EXISTS idx_slot_popularity_tenant ON slot_popularity(tenant_id);
CREATE INDEX IF NOT EXISTS idx_slot_popularity_service ON slot_popularity(service_id);
CREATE INDEX IF NOT EXISTS idx_slot_popularity_professional ON slot_popularity(professional_id);
CREATE INDEX IF NOT EXISTS idx_slot_popularity_time ON slot_popularity(day_of_week, hour_slot);
CREATE INDEX IF NOT EXISTS idx_slot_popularity_ranking ON slot_popularity(tenant_id, booking_count DESC, success_rate DESC);

-- Comments for documentation
COMMENT ON TABLE user_prefs IS 'User preferences for personalized slot recommendations';
COMMENT ON COLUMN user_prefs.phone_e164 IS 'Phone number in E.164 format (primary key)';
COMMENT ON COLUMN user_prefs.service_top IS 'Top services used by user with usage count in JSONB format';
COMMENT ON COLUMN user_prefs.slot_window_pref IS 'Preferred time window: morning, afternoon, or evening';
COMMENT ON COLUMN user_prefs.preferred_days IS 'Array of preferred days (0=Sunday, 6=Saturday)';

COMMENT ON TABLE slot_popularity IS 'Global slot popularity for fallback recommendations';
COMMENT ON COLUMN slot_popularity.success_rate IS 'Rate of successful bookings for this slot (0.0 to 1.0)';
COMMENT ON COLUMN slot_popularity.booking_count IS 'Total number of bookings attempted for this slot';