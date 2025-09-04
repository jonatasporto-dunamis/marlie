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

-- 4) Opcional: estatísticas atualizadas
ANALYZE public.servicos_prof;