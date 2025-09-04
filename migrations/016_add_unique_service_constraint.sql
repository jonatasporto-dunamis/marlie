-- Migration 016: Add unique constraint for service name normalization
-- Prevent duplicate services per tenant using normalized service name

-- Create unique index to prevent duplicate service names within the same tenant
-- This enforces business rule: one service name per tenant (case-insensitive, trimmed)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_servico_nome_norm 
ON servicos_prof (tenant_id, servico_nome_norm);

-- Add comment explaining the constraint
COMMENT ON INDEX uniq_servico_nome_norm IS 
'Unique constraint preventing duplicate service names within tenant (case-insensitive, trimmed)';

-- Note: This migration should be run after 015_optimize_catalog_indexes.sql
-- to ensure the servico_nome_norm column exists