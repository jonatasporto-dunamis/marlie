-- Migration 015: Optimize catalog indexes for performance
-- Add normalized column and create optimized indexes for servicos_prof table

-- Add normalized service name column for efficient searching
ALTER TABLE servicos_prof 
ADD COLUMN IF NOT EXISTS servico_nome_norm text 
GENERATED ALWAYS AS (lower(btrim(servico_nome))) STORED;

-- Create lookup index for common catalog queries (updated version)
-- This index supports queries filtering by tenant, active status, visibility, and service name
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_servicos_prof_lookup_v2 
ON servicos_prof (tenant_id, ativo, visivel_cliente, servico_nome_norm);

-- Create index for service ID lookups within tenant (updated version)
-- This index supports queries filtering by tenant and specific service ID
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_servicos_prof_servico_v2 
ON servicos_prof (tenant_id, servico_id);

-- Create composite index for tenant-based queries with ordering
-- This index supports queries that need to order by normalized name within tenant
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_servicos_prof_tenant_order 
ON servicos_prof (tenant_id, servico_nome_norm) 
WHERE ativo = true AND visivel_cliente = true;

-- Add comment explaining the optimization
COMMENT ON COLUMN servicos_prof.servico_nome_norm IS 
'Normalized service name (lowercase, trimmed) for efficient searching and deduplication';

COMMENT ON INDEX idx_servicos_prof_lookup IS 
'Optimized index for catalog lookup queries filtering by tenant, status, and service name';

COMMENT ON INDEX idx_servicos_prof_servico IS 
'Index for service ID lookups within tenant scope';

COMMENT ON INDEX idx_servicos_prof_tenant_order IS 
'Partial index for active, visible services ordered by normalized name within tenant';