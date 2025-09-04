-- P1.1 — UPSERT de exemplo: normaliza nome e respeita unicidade por (tenant_id, servico_nome_norm)
-- Parâmetros (ajuste antes de rodar):
-- :tenant, :servico_id, :servico_nome, :ativo, :visivel_cliente

WITH dados AS (
  SELECT
    :tenant::text          AS tenant_id,
    :servico_id::integer   AS servico_id,
    :servico_nome::text    AS servico_nome,
    lower(btrim(:servico_nome::text)) AS servico_nome_norm,
    :ativo::boolean        AS ativo,
    :visivel_cliente::boolean AS visivel_cliente
)
INSERT INTO public.servicos_prof
  (tenant_id, servico_id, servico_nome, ativo, visivel_cliente)
SELECT tenant_id, servico_id, servico_nome, ativo, visivel_cliente
FROM dados
ON CONFLICT ON CONSTRAINT uniq_servico_nome_norm_pt2
DO UPDATE SET
  servico_id       = EXCLUDED.servico_id,   -- regra de merge: atualiza ID se mudou
  servico_nome     = EXCLUDED.servico_nome, -- mantém o nome "bonito"
  ativo            = EXCLUDED.ativo,
  visivel_cliente  = EXCLUDED.visivel_cliente
RETURNING *;

-- Exemplo de parâmetros:
-- \set tenant '42'
-- \set servico_id 1001
-- \set servico_nome '  Corte  Feminino '
-- \set ativo true
-- \set visivel_cliente true
-- Rode o CTE acima após setar os parâmetros