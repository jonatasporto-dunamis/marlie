-- P1.1 — PERF TEST: consulta típica de sugestões usando o índice de lookup
-- Substitua :tenant e :prefixo pelos valores desejados

-- Dica: use um prefixo em minúsculas, já que servico_nome_norm é lower(...)
-- Ex.: SET LOCAL application_name TO 'perf_test_sugestoes';

EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT servico_id, servico_nome
FROM public.servicos_prof
WHERE tenant_id = :tenant
  AND ativo = true
  AND visivel_cliente = true
  AND servico_nome_norm LIKE (:prefixo || '%')
ORDER BY servico_nome_norm
LIMIT 20;

-- Aceite esperado:
-- - O plano deve mostrar uso do idx_servicos_prof_lookup_pt2
-- - Tempo total (Actual Total Time) < 50 ms com >80 itens por tenant

-- Exemplo de execução manual:
-- Exemplo: tenant '42' e prefixo 'cor' (corte de 'Corte', 'Coloração' etc.)
-- \set tenant '42'
-- \set prefixo 'cor'
-- EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
-- SELECT servico_id, servico_nome
-- FROM public.servicos_prof
-- WHERE tenant_id = :tenant
--   AND ativo = true
--   AND visivel_cliente = true
--   AND servico_nome_norm LIKE (:prefixo || '%')
-- ORDER BY servico_nome_norm
-- LIMIT 20;