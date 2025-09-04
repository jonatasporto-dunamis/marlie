-- P1.2 — HELPER: construir a chave idempotente (string) no SQL
-- formatação: idem:{tenant_id}:{sha256(phone|servicoId|date|time)}

-- Verificar se a extensão pgcrypto está instalada
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Função helper para gerar chave idempotente
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

-- Exemplo de uso da função:
-- SELECT generate_idempotency_key('42', '11999999999', 1001, '2024-01-15', '14:30');

-- Ou usando SELECT direto (sem função):
SELECT
  'idem:' || :tenant || ':' ||
  encode(
    digest(
      :phone || '|' || :servico_id || '|' || :data || '|' || :hora,
      'sha256'
    ),
    'hex'
  ) AS redis_key;

-- Exemplo de parâmetros:
-- \set tenant '42'
-- \set phone '11999999999'
-- \set servico_id 1001
-- \set data '2024-01-15'
-- \set hora '14:30'