-- Migration: Supabase Setup for Syncbelle
-- Date: 2024-01-XX
-- Description: Configurações específicas para o Supabase

-- Habilitar extensões necessárias no Supabase
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Configurar timezone padrão
SET timezone = 'America/Bahia';

-- Criar função para definir tenant_id na sessão
CREATE OR REPLACE FUNCTION set_tenant_id(tenant_id_param TEXT)
RETURNS VOID AS $$
BEGIN
  PERFORM set_config('app.tenant_id', tenant_id_param, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Criar função para obter tenant_id atual
CREATE OR REPLACE FUNCTION get_current_tenant_id()
RETURNS TEXT AS $$
BEGIN
  RETURN current_setting('app.tenant_id', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Criar função para validar tenant_id
CREATE OR REPLACE FUNCTION validate_tenant_id(tenant_id_param TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM tenants 
    WHERE tenant_id = tenant_id_param 
    AND status = 'active'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Criar função para criptografia de configurações sensíveis
CREATE OR REPLACE FUNCTION encrypt_config_value(value_text TEXT, key_text TEXT DEFAULT 'default')
RETURNS TEXT AS $$
BEGIN
  -- Usar pgcrypto para criptografar valores sensíveis
  RETURN encode(pgp_sym_encrypt(value_text, key_text), 'base64');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Criar função para descriptografia de configurações sensíveis
CREATE OR REPLACE FUNCTION decrypt_config_value(encrypted_value TEXT, key_text TEXT DEFAULT 'default')
RETURNS TEXT AS $$
BEGIN
  -- Usar pgcrypto para descriptografar valores sensíveis
  RETURN pgp_sym_decrypt(decode(encrypted_value, 'base64'), key_text);
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL; -- Retorna NULL se não conseguir descriptografar
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Criar função para auditoria de mudanças
CREATE OR REPLACE FUNCTION audit_trigger_function()
RETURNS TRIGGER AS $$
BEGIN
  -- Log de auditoria para mudanças importantes
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (table_name, operation, tenant_id, record_id, new_values, created_at)
    VALUES (TG_TABLE_NAME, TG_OP, NEW.tenant_id, NEW.id, to_jsonb(NEW), NOW());
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO audit_log (table_name, operation, tenant_id, record_id, old_values, new_values, created_at)
    VALUES (TG_TABLE_NAME, TG_OP, NEW.tenant_id, NEW.id, to_jsonb(OLD), to_jsonb(NEW), NOW());
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (table_name, operation, tenant_id, record_id, old_values, created_at)
    VALUES (TG_TABLE_NAME, TG_OP, OLD.tenant_id, OLD.id, to_jsonb(OLD), NOW());
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Criar tabela de auditoria se não existir
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  tenant_id TEXT,
  record_id UUID,
  old_values JSONB,
  new_values JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Criar índices para a tabela de auditoria
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_id ON audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_table_name ON audit_log(table_name);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- Habilitar RLS na tabela de auditoria
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Criar política RLS para auditoria
CREATE POLICY audit_log_tenant_isolation ON audit_log
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Criar função para limpeza automática de logs antigos
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Remove logs de auditoria com mais de 90 dias
  DELETE FROM audit_log 
  WHERE created_at < NOW() - INTERVAL '90 days';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Configurações específicas do Supabase para performance
-- Estas configurações são aplicadas automaticamente pelo Supabase,
-- mas podem ser ajustadas conforme necessário

-- Comentários sobre configurações recomendadas:
-- shared_preload_libraries = 'pg_stat_statements'
-- max_connections = 100 (padrão do Supabase)
-- work_mem = '4MB'
-- maintenance_work_mem = '64MB'
-- effective_cache_size = '1GB'
-- random_page_cost = 1.1
-- seq_page_cost = 1.0

-- Criar view para monitoramento de performance
CREATE OR REPLACE VIEW performance_stats AS
SELECT 
  query,
  calls,
  total_time,
  mean_time,
  rows,
  100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0) AS hit_percent
FROM pg_stat_statements
ORDER BY total_time DESC
LIMIT 20;

-- Comentário final
COMMENT ON SCHEMA public IS 'Syncbelle - Configurado para Supabase';