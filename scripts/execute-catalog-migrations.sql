-- MIGRAÇÃO COMPLETA DO CATÁLOGO - EXECUTE COMO SUPERUSER
-- Baseado no prompt do usuário com melhorias de idempotência
-- Tabela alvo: servicos_prof

-- 1) Verificação de sanidade
DO $$ 
BEGIN 
  IF NOT EXISTS ( 
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'servicos_prof' 
  ) THEN 
    RAISE EXCEPTION 'ERRO: Tabela public.servicos_prof não existe. Crie-a antes desta migração.'; 
  END IF;
  RAISE NOTICE 'OK: Tabela servicos_prof encontrada.';
END 
$$;

-- 2) Instalar extensão pgcrypto (necessária para SHA256)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 3) Coluna normalizada (gerada) — lower(btrim(servico_nome))
ALTER TABLE servicos_prof
  ADD COLUMN IF NOT EXISTS servico_nome_norm TEXT
  GENERATED ALWAYS AS (lower(btrim(servico_nome))) STORED;

-- 4) Índices (idempotentes)
CREATE INDEX IF NOT EXISTS idx_servicos_prof_lookup
  ON servicos_prof (tenant_id, ativo, visivel_cliente, servico_nome_norm);

CREATE INDEX IF NOT EXISTS idx_servicos_prof_servico
  ON servicos_prof (tenant_id, servico_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_servicos_prof_nome_norm'
  ) THEN
    CREATE UNIQUE INDEX uniq_servicos_prof_nome_norm
      ON servicos_prof (tenant_id, servico_nome_norm);
  END IF;
END$$;

-- 5) Trigger de fallback (se algum cliente antigo não suportar GENERATED)
CREATE OR REPLACE FUNCTION fn_norm_servico_nome()
RETURNS trigger AS $$
BEGIN
  NEW.servico_nome_norm := lower(btrim(NEW.servico_nome));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_norm_servico_nome ON servicos_prof;
CREATE TRIGGER tg_norm_servico_nome
  BEFORE INSERT OR UPDATE OF servico_nome
  ON servicos_prof
  FOR EACH ROW
  EXECUTE FUNCTION fn_norm_servico_nome();

-- 6) Função helper para chaves de idempotência
CREATE OR REPLACE FUNCTION generate_idempotency_key(
  p_tenant_id text,
  p_phone text,
  p_servico_id text,
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

-- 7) Atualizar estatísticas
ANALYZE servicos_prof;

-- 8) Verificação final
DO $$
DECLARE
  col_count int;
  idx_count int;
BEGIN
  -- Verificar coluna normalizada
  SELECT COUNT(*) INTO col_count
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'servicos_prof' 
    AND column_name = 'servico_nome_norm';
  
  IF col_count = 0 THEN
    RAISE WARNING 'Coluna servico_nome_norm não foi criada!';
  ELSE
    RAISE NOTICE 'OK: Coluna servico_nome_norm criada com sucesso.';
  END IF;
  
  -- Verificar índices
  SELECT COUNT(*) INTO idx_count
  FROM pg_indexes 
  WHERE tablename = 'servicos_prof' 
    AND indexname IN ('idx_servicos_prof_lookup', 'idx_servicos_prof_servico', 'uniq_servicos_prof_nome_norm');
  
  RAISE NOTICE 'Índices criados: % de 3 esperados', idx_count;
  
  -- Verificar função
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'generate_idempotency_key') THEN
    RAISE NOTICE 'OK: Função generate_idempotency_key criada.';
  ELSE
    RAISE WARNING 'Função generate_idempotency_key não foi criada!';
  END IF;
  
  -- Verificar trigger
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tg_norm_servico_nome') THEN
    RAISE NOTICE 'OK: Trigger de normalização criado.';
  ELSE
    RAISE WARNING 'Trigger de normalização não foi criado!';
  END IF;
END
$$;

RAISE NOTICE 'Migração do catálogo concluída com sucesso!';