-- ROLLBACK DAS MIGRAÇÕES DO CATÁLOGO
-- Execute apenas se necessário desfazer as otimizações

-- ATENÇÃO: Este script remove os índices mas mantém a coluna servico_nome_norm
-- pois ela pode conter dados importantes e é uma coluna gerada

\echo '=== INICIANDO ROLLBACK DAS MIGRAÇÕES DO CATÁLOGO ==='

-- 1) Verificar se a tabela existe
DO $$ 
BEGIN 
  IF NOT EXISTS ( 
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'servicos_prof' 
  ) THEN 
    RAISE EXCEPTION 'ERRO: Tabela public.servicos_prof não existe.'; 
  END IF;
  RAISE NOTICE 'OK: Tabela servicos_prof encontrada.';
END 
$$;

-- 2) Remover função de idempotência
\echo 'Removendo função generate_idempotency_key...'
DROP FUNCTION IF EXISTS generate_idempotency_key(text, text, text, text, text);

-- 3) Remover índices criados (ordem inversa para evitar dependências)
\echo 'Removendo índices criados...';

-- Índice único de nome normalizado
DROP INDEX IF EXISTS uniq_servico_nome_norm;

-- Índice de lookup para sugestões
DROP INDEX IF EXISTS idx_servicos_prof_lookup;

-- Índice por servico_id
DROP INDEX IF EXISTS idx_servicos_prof_servico;

-- 4) OPCIONAL: Remover coluna normalizada
-- DESCOMENTE APENAS SE REALMENTE NECESSÁRIO
-- ATENÇÃO: Isso pode causar perda de dados se a coluna estiver sendo usada
/*
\echo 'REMOVENDO COLUNA servico_nome_norm (DESCOMENTE PARA EXECUTAR)...';
ALTER TABLE public.servicos_prof DROP COLUMN IF EXISTS servico_nome_norm;
*/

-- 5) OPCIONAL: Remover extensão pgcrypto
-- DESCOMENTE APENAS SE NENHUMA OUTRA PARTE DO SISTEMA USA
/*
\echo 'REMOVENDO EXTENSÃO pgcrypto (DESCOMENTE PARA EXECUTAR)...';
DROP EXTENSION IF EXISTS pgcrypto;
*/

-- 6) Verificação final
DO $$
DECLARE
  idx_count int;
  col_exists boolean;
  func_exists boolean;
BEGIN
  -- Verificar índices removidos
  SELECT COUNT(*) INTO idx_count
  FROM pg_indexes 
  WHERE tablename = 'servicos_prof' 
    AND indexname IN ('idx_servicos_prof_lookup', 'idx_servicos_prof_servico', 'uniq_servico_nome_norm');
  
  IF idx_count = 0 THEN
    RAISE NOTICE 'OK: Todos os índices customizados foram removidos.';
  ELSE
    RAISE WARNING 'ATENÇÃO: % índices ainda existem!', idx_count;
  END IF;
  
  -- Verificar coluna (se ainda existe)
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'servicos_prof' 
      AND column_name = 'servico_nome_norm'
  ) INTO col_exists;
  
  IF col_exists THEN
    RAISE NOTICE 'INFO: Coluna servico_nome_norm ainda existe (recomendado manter).';
  ELSE
    RAISE NOTICE 'INFO: Coluna servico_nome_norm foi removida.';
  END IF;
  
  -- Verificar função
  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'generate_idempotency_key'
  ) INTO func_exists;
  
  IF func_exists THEN
    RAISE WARNING 'ATENÇÃO: Função generate_idempotency_key ainda existe!';
  ELSE
    RAISE NOTICE 'OK: Função generate_idempotency_key foi removida.';
  END IF;
END
$$;

-- 7) Atualizar estatísticas
ANALYZE public.servicos_prof;

\echo '=== ROLLBACK CONCLUÍDO ==='
\echo 'Resumo:';
\echo '- Índices customizados: REMOVIDOS';
\echo '- Função de idempotência: REMOVIDA';
\echo '- Coluna servico_nome_norm: MANTIDA (descomente para remover)';
\echo '- Extensão pgcrypto: MANTIDA (descomente para remover)';
\echo '';
\echo 'IMPORTANTE:';
\echo '- A remoção dos índices pode impactar a performance de consultas';
\echo '- Considere recriar os índices se a performance degradar';
\echo '- A coluna servico_nome_norm foi mantida por segurança';
\echo '- Para remover completamente, descomente as seções marcadas';