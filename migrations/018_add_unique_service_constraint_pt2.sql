-- P1.1 — UNICIDADE por tenant + nome normalizado
-- Garante que não entram duplicados do mesmo serviço por tenant

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_servico_nome_norm_pt2
  ON public.servicos_prof (tenant_id, servico_nome_norm);

-- Observação: se já existirem duplicados hoje,
-- este índice pode falhar. Nesse caso, rode primeiro um script de dedupe
-- (posso gerar um sob medida quando você quiser).