-- Script consolidado para executar todas as migrações de catálogo
-- Execute este arquivo diretamente no PostgreSQL com privilégios de escrita

-- Verificar se a extensão pgcrypto está disponível
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- P1.1 — MIGRAÇÃO CATÁLOGO: coluna normalizada + índices
-- Alvo: tabela servicos_prof (tabela existente no sistema)

-- 0) Sanidade: confirme que a tabela existe (só avisa se não existir)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'servicos_prof'
  ) THEN
    RAISE NOTICE 'ATENÇÃO: Tabela public.servicos_prof não existe. Crie-a antes desta migração.';
  END IF;
END
$$;

-- 1) Coluna normalizada (gerada) — lower(btrim(servico_nome))
ALTER TABLE public.servicos_prof
  ADD COLUMN IF NOT EXISTS servico_nome_norm text
  GENERATED ALWAYS AS (lower(btrim(servico_nome))) STORED;

-- 2) Índice de lookup para sugestões/autocomplete
-- (tenant_id, ativo, visivel_cliente, servico_nome_norm)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_servicos_prof_lookup_pt2
  ON public.servicos_prof (tenant_id, ativo, visivel_cliente, servico_nome_norm);

-- 3) Índice por (tenant_id, servico_id) para joins e validações rápidas
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_servicos_prof_servico_pt2
  ON public.servicos_prof (tenant_id, servico_id);

-- 4) Índice único para evitar duplicados
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_servico_nome_norm_pt2
  ON public.servicos_prof (tenant_id, servico_nome_norm);

-- 5) Função helper para gerar chave idempotente
CREATE OR REPLACE FUNCTION generate_idempotency_key(
  p_tenant_id text,
  p_phone text,
  p_servico_id integer,
  p_data text,
  p_hora text
) RETURNS text AS $$
BEGIN
  RETURN 'idem:' || p_tenant_id || ':' ||
    encode(
      digest(
        p_phone || '|' || p_servico_id || '|' || p_data || '|' || p_hora,
        'sha256'
      ),
      'hex'
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 6) Estatísticas atualizadas
ANALYZE public.servicos_prof;

-- Verificar se tudo foi criado corretamente
SELECT 
  'Coluna servico_nome_norm criada' as status,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'servicos_prof' AND column_name = 'servico_nome_norm'
  ) THEN 'SIM' ELSE 'NÃO' END as existe;

SELECT 
  'Índices criados' as status,
  COUNT(*) as total_indices
FROM pg_indexes 
WHERE tablename = 'servicos_prof' AND indexname LIKE '%pt2%';

SELECT 
  'Função idempotência criada' as status,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'generate_idempotency_key'
  ) THEN 'SIM' ELSE 'NÃO' END as existe;