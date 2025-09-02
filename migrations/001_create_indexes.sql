-- Migration: Create performance indexes for servicos_prof table
-- Date: 2024-01-22
-- Description: Add indexes to improve query performance and normalize servico_nome

-- Create index for professional service lookup
-- This index optimizes queries that filter by tenant_id, ativo, visivel_cliente and search by servico_nome
CREATE INDEX IF NOT EXISTS idx_servicos_prof_lookup 
  ON servicos_prof (tenant_id, ativo, visivel_cliente, lower(servico_nome));

-- Create index for service ID lookup
-- This index optimizes queries that filter by tenant_id and servico_id
CREATE INDEX IF NOT EXISTS idx_servicos_prof_servico 
  ON servicos_prof (tenant_id, servico_id);

-- Create index for professional ID lookup
-- This index optimizes queries that filter by tenant_id and profissional_id
CREATE INDEX IF NOT EXISTS idx_servicos_prof_profissional 
  ON servicos_prof (tenant_id, profissional_id) 
  WHERE profissional_id IS NOT NULL;

-- Create index for last_synced_at for time-based queries
CREATE INDEX IF NOT EXISTS idx_servicos_prof_last_synced 
  ON servicos_prof (tenant_id, last_synced_at DESC);

-- Add function to normalize servico_nome
CREATE OR REPLACE FUNCTION normalize_servico_nome()
RETURNS TRIGGER AS $$
BEGIN
  -- Normalize servico_nome: trim whitespace and convert to lowercase
  IF NEW.servico_nome IS NOT NULL THEN
    NEW.servico_nome := lower(trim(NEW.servico_nome));
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically normalize servico_nome on INSERT and UPDATE
DROP TRIGGER IF EXISTS trigger_normalize_servico_nome ON servicos_prof;
CREATE TRIGGER trigger_normalize_servico_nome
  BEFORE INSERT OR UPDATE ON servicos_prof
  FOR EACH ROW
  EXECUTE FUNCTION normalize_servico_nome();

-- Update existing records to normalize servico_nome
UPDATE servicos_prof 
SET servico_nome = lower(trim(servico_nome))
WHERE servico_nome IS NOT NULL 
  AND servico_nome != lower(trim(servico_nome));

-- Create index for normalized servico_nome searches
CREATE INDEX IF NOT EXISTS idx_servicos_prof_servico_nome_normalized 
  ON servicos_prof (tenant_id, servico_nome) 
  WHERE servico_nome IS NOT NULL;

-- Add comments for documentation
COMMENT ON INDEX idx_servicos_prof_lookup IS 'Optimizes professional service lookup queries with tenant, status and name filters';
COMMENT ON INDEX idx_servicos_prof_servico IS 'Optimizes service ID lookup queries';
COMMENT ON INDEX idx_servicos_prof_profissional IS 'Optimizes professional ID lookup queries';
COMMENT ON INDEX idx_servicos_prof_last_synced IS 'Optimizes time-based queries for service synchronization';
COMMENT ON INDEX idx_servicos_prof_servico_nome_normalized IS 'Optimizes normalized service name searches';
COMMENT ON FUNCTION normalize_servico_nome() IS 'Automatically normalizes servico_nome field to prevent duplicates';
COMMENT ON TRIGGER trigger_normalize_servico_nome ON servicos_prof IS 'Triggers normalization of servico_nome on insert/update';