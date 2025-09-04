-- Migration: Create tenants and tenant_configs tables for multi-tenant foundation
-- Date: 2024-01-XX
-- Description: P0.1 - Foundation tables for multi-tenant architecture with RLS

-- Enable Row Level Security extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create tenants table
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'inactive')),
  plan TEXT NOT NULL DEFAULT 'basic' CHECK (plan IN ('basic', 'premium', 'enterprise')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- Create tenant_configs table for encrypted credentials storage
CREATE TABLE IF NOT EXISTS tenant_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  config_key TEXT NOT NULL,
  config_value_encrypted TEXT NOT NULL, -- AES-GCM encrypted value
  config_type TEXT NOT NULL DEFAULT 'credential' CHECK (config_type IN ('credential', 'setting', 'api_key', 'webhook_url')),
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_rotated_at TIMESTAMPTZ,
  
  -- Ensure unique config keys per tenant
  UNIQUE (tenant_id, config_key)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_tenants_tenant_id ON tenants(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_tenant_configs_tenant_key ON tenant_configs(tenant_id, config_key);
CREATE INDEX IF NOT EXISTS idx_tenant_configs_type ON tenant_configs(config_type);
CREATE INDEX IF NOT EXISTS idx_tenant_configs_active ON tenant_configs(tenant_id, is_active) WHERE is_active = TRUE;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_tenant_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for automatic timestamp updates
CREATE TRIGGER trigger_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION update_tenant_updated_at();

CREATE TRIGGER trigger_tenant_configs_updated_at
  BEFORE UPDATE ON tenant_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_tenant_updated_at();

-- Insert default tenant for development/migration compatibility
INSERT INTO tenants (tenant_id, name, status, plan, metadata)
VALUES (
  'default',
  'Default Tenant',
  'active',
  'basic',
  '{"description": "Default tenant for backward compatibility and development"}'
)
ON CONFLICT (tenant_id) DO NOTHING;

-- Enable RLS on tenant_configs (tenants table doesn't need RLS as it's admin-only)
ALTER TABLE tenant_configs ENABLE ROW LEVEL SECURITY;

-- Create RLS policy for tenant_configs - only allow access to own tenant's configs
CREATE POLICY tenant_configs_isolation ON tenant_configs
  FOR ALL
  TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Comments for documentation
COMMENT ON TABLE tenants IS 'Master table of all tenants in the system';
COMMENT ON TABLE tenant_configs IS 'Encrypted configuration storage per tenant (credentials, API keys, etc.)';
COMMENT ON COLUMN tenant_configs.config_value_encrypted IS 'AES-GCM encrypted configuration value';
COMMENT ON COLUMN tenant_configs.config_type IS 'Type of configuration: credential, setting, api_key, webhook_url';

-- Grant permissions (adjust as needed for your application user)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO app_user;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_configs TO app_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

COMMIT;