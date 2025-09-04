-- TESTE DE PERFORMANCE DO CATÁLOGO
-- Execute após rodar execute-catalog-migrations.sql

-- 1) Inserir dados de teste se não existirem
DO $$
DECLARE
  record_count int;
BEGIN
  SELECT COUNT(*) INTO record_count FROM public.servicos_prof WHERE tenant_id = '42';
  
  IF record_count < 50 THEN
    RAISE NOTICE 'Inserindo dados de teste para tenant 42...';
    
    -- Inserir serviços de exemplo
    INSERT INTO public.servicos_prof 
      (tenant_id, servico_id, servico_nome, ativo, visivel_cliente, profissional_id, duracao_min, valor)
    VALUES 
      ('42', 1001, 'Corte Feminino', true, true, 1, 45, 50.00),
      ('42', 1002, 'Corte Masculino', true, true, 1, 30, 35.00),
      ('42', 1003, 'Coloração', true, true, 2, 120, 150.00),
      ('42', 1004, 'Escova', true, true, 1, 60, 40.00),
      ('42', 1005, 'Hidratação', true, true, 2, 45, 60.00),
      ('42', 1006, 'Manicure', true, true, 3, 30, 25.00),
      ('42', 1007, 'Pedicure', true, true, 3, 45, 30.00),
      ('42', 1008, 'Sobrancelha', true, true, 4, 20, 20.00),
      ('42', 1009, 'Depilação Perna', true, true, 4, 60, 80.00),
      ('42', 1010, 'Massagem Relaxante', true, true, 5, 90, 120.00),
      ('42', 1011, 'Limpeza de Pele', true, true, 6, 75, 90.00),
      ('42', 1012, 'Peeling', true, true, 6, 45, 70.00),
      ('42', 1013, 'Botox Capilar', true, true, 2, 180, 200.00),
      ('42', 1014, 'Progressiva', true, true, 2, 240, 300.00),
      ('42', 1015, 'Reflexologia', true, true, 5, 60, 80.00)
    ON CONFLICT (tenant_id, servico_nome_norm) DO NOTHING;
    
    RAISE NOTICE 'Dados de teste inseridos.';
  ELSE
    RAISE NOTICE 'Dados de teste já existem (% registros)', record_count;
  END IF;
END
$$;

-- 2) Verificar se os índices estão sendo usados
\echo '=== TESTE 1: Verificação de índices ==='
SELECT 
  schemaname,
  tablename,
  indexname,
  idx_scan as "Usos do Índice",
  idx_tup_read as "Tuplas Lidas",
  idx_tup_fetch as "Tuplas Buscadas"
FROM pg_stat_user_indexes 
WHERE tablename = 'servicos_prof'
ORDER BY idx_scan DESC;

-- 3) Teste de performance - busca por prefixo
\echo '=== TESTE 2: Performance de busca por prefixo "cor" ==='
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT servico_id, servico_nome, duracao_min, valor
FROM public.servicos_prof 
WHERE tenant_id = '42'
  AND ativo = true 
  AND visivel_cliente = true 
  AND servico_nome_norm LIKE 'cor%'
ORDER BY servico_nome_norm 
LIMIT 20;

-- 4) Teste de performance - busca exata
\echo '=== TESTE 3: Performance de busca exata ==='
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT servico_id, servico_nome, duracao_min, valor
FROM public.servicos_prof 
WHERE tenant_id = '42'
  AND servico_nome_norm = 'corte feminino';

-- 5) Teste do índice de servico_id
\echo '=== TESTE 4: Performance de busca por servico_id ==='
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT servico_nome, ativo, visivel_cliente
FROM public.servicos_prof 
WHERE tenant_id = '42'
  AND servico_id = 1001;

-- 6) Teste de UPSERT
\echo '=== TESTE 5: UPSERT normalizado ==='
WITH dados AS (
  SELECT 
    '42'::text AS tenant_id,
    1016::integer AS servico_id,
    '  NOVO SERVIÇO TESTE  '::text AS servico_nome,
    true::boolean AS ativo,
    true::boolean AS visivel_cliente,
    1::integer AS profissional_id,
    60::integer AS duracao_min,
    75.00::numeric AS valor
)
INSERT INTO public.servicos_prof 
  (tenant_id, servico_id, servico_nome, ativo, visivel_cliente, profissional_id, duracao_min, valor)
SELECT tenant_id, servico_id, servico_nome, ativo, visivel_cliente, profissional_id, duracao_min, valor
FROM dados
ON CONFLICT (tenant_id, servico_nome_norm)
DO UPDATE SET 
  servico_id = EXCLUDED.servico_id,
  servico_nome = EXCLUDED.servico_nome,
  ativo = EXCLUDED.ativo,
  visivel_cliente = EXCLUDED.visivel_cliente,
  duracao_min = EXCLUDED.duracao_min,
  valor = EXCLUDED.valor,
  last_synced_at = now()
RETURNING servico_id, servico_nome, servico_nome_norm;

-- 7) Teste da função de idempotência
\echo '=== TESTE 6: Função de idempotência ==='
SELECT 
  generate_idempotency_key('42', '11999887766', '1001', '2024-01-15', '14:30') as chave_redis_1,
  generate_idempotency_key('42', '11999887766', '1001', '2024-01-15', '14:30') as chave_redis_2,
  generate_idempotency_key('42', '11999887766', '1002', '2024-01-15', '14:30') as chave_redis_diferente;

-- 8) Verificar normalização
\echo '=== TESTE 7: Verificação de normalização ==='
SELECT 
  servico_nome as "Nome Original",
  servico_nome_norm as "Nome Normalizado",
  length(servico_nome) as "Tamanho Original",
  length(servico_nome_norm) as "Tamanho Normalizado"
FROM public.servicos_prof 
WHERE tenant_id = '42'
ORDER BY servico_nome_norm
LIMIT 10;

-- 9) Estatísticas finais
\echo '=== TESTE 8: Estatísticas da tabela ==='
SELECT 
  COUNT(*) as total_registros,
  COUNT(DISTINCT tenant_id) as total_tenants,
  COUNT(CASE WHEN ativo = true THEN 1 END) as servicos_ativos,
  COUNT(CASE WHEN visivel_cliente = true THEN 1 END) as servicos_visiveis
FROM public.servicos_prof;

\echo '=== TESTES CONCLUÍDOS ==='
\echo 'Verifique se:';
\echo '1. Os índices estão sendo usados (Index Scan nos EXPLAIN)';
\echo '2. Tempo de execução < 50ms para buscas';
\echo '3. UPSERT funcionou corretamente';
\echo '4. Chaves de idempotência são consistentes';
\echo '5. Normalização está funcionando (espaços removidos, minúsculas)';