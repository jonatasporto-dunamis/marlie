-- ROLLBACK OPCIONAL — remove índices criados neste P1 (NÃO remove a coluna)
DROP INDEX IF EXISTS idx_servicos_prof_lookup_pt2;
DROP INDEX IF EXISTS idx_servicos_prof_servico_pt2;
DROP INDEX IF EXISTS uniq_servico_nome_norm_pt2;

-- Remove a função helper de idempotência
DROP FUNCTION IF EXISTS generate_idempotency_key(text, text, integer, text, text);

-- Manter a coluna servico_nome_norm é recomendável.
-- Se realmente quiser remover:
-- ALTER TABLE public.servicos_prof DROP COLUMN IF EXISTS servico_nome_norm;

-- Observação: Este rollback deve ser usado apenas em caso de problemas.
-- Os índices melhoram significativamente a performance das consultas.