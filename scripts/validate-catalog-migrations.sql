-- VALIDAÇÃO DAS MIGRAÇÕES DO CATÁLOGO
-- Execute após aplicar execute-catalog-migrations.sql

-- 1) Verificar estrutura da tabela
SELECT 
  column_name, 
  data_type, 
  is_nullable, 
  column_default,
  is_generated,
  generation_expression
FROM information_schema.columns 
WHERE table_name = 'servicos_prof' 
ORDER BY ordinal_position;

-- 2) Verificar índices criados
SELECT 
  indexname,
  indexdef
FROM pg_indexes 
WHERE tablename = 'servicos_prof'
ORDER BY indexname;

-- 3) Verificar funções criadas
SELECT 
  proname as function_name,
  prosrc as function_body
FROM pg_proc 
WHERE proname IN ('generate_idempotency_key', 'fn_norm_servico_nome');

-- 4) Verificar triggers
SELECT 
  tgname as trigger_name,
  tgtype,
  tgenabled
FROM pg_trigger 
WHERE tgrelid = 'servicos_prof'::regclass;

-- 5) Teste de normalização
SELECT 
  '  TESTE NORMALIZAÇÃO  ' as original,
  lower(btrim('  TESTE NORMALIZAÇÃO  ')) as normalizado;

-- 6) Teste da função de idempotência
SELECT 
  generate_idempotency_key('42', '11999887766', '1001', '2024-01-15', '14:30') as chave_redis;

-- 7) Teste de performance (se houver dados)
EXPLAIN ANALYZE
SELECT id, servico_id, servico_nome 
FROM servicos_prof 
WHERE tenant_id = 'TENANT_TESTE'
  AND ativo = true 
  AND visivel_cliente = true 
  AND servico_nome_norm LIKE 'corte%';

-- 8) Estatísticas da tabela
SELECT 
  COUNT(*) as total_registros,
  COUNT(DISTINCT tenant_id) as total_tenants,
  COUNT(CASE WHEN ativo = true THEN 1 END) as servicos_ativos,
  COUNT(CASE WHEN servico_nome_norm IS NOT NULL THEN 1 END) as com_nome_normalizado
FROM servicos_prof;