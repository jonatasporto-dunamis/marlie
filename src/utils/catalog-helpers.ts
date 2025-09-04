/**
 * Helpers para otimização de catálogo - P1.1
 * Implementa normalização de nomes de serviços e upsert com deduplicação
 */

import { Pool } from 'pg';
import crypto from 'crypto';

/**
 * Normaliza o nome do serviço seguindo a mesma regra do banco
 * @param servicoNome Nome do serviço a ser normalizado
 * @returns Nome normalizado (trim + lowercase)
 */
export function normalizeServiceName(servicoNome: string): string {
  return servicoNome.trim().toLowerCase();
}

/**
 * Gera chave de idempotência para Redis
 * Formato: idem:{tenant_id}:{sha256(phone|servicoId|date|time)}
 */
export function generateIdempotencyKey(
  tenantId: string,
  phone: string,
  servicoId: number,
  data: string,
  hora: string
): string {
  const payload = `${phone}|${servicoId}|${data}|${hora}`;
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  return `idem:${tenantId}:${hash}`;
}

/**
 * Interface para dados de serviço profissional
 */
export interface ServicoProf {
  tenant_id: string;
  servico_id: number;
  servico_nome: string;
  ativo: boolean;
  visivel_cliente: boolean;
  duracao_min?: number;
  valor?: number;
  profissional_id?: number;
}

/**
 * Executa upsert normalizado de serviço profissional
 * Usa a constraint única em servico_nome_norm para evitar duplicados
 */
export async function upsertServicoProf(
  pool: Pool,
  servico: ServicoProf
): Promise<ServicoProf> {
  const query = `
    WITH dados AS (
      SELECT 
        $1::text AS tenant_id,
        $2::integer AS servico_id,
        $3::text AS servico_nome,
        $4::boolean AS ativo,
        $5::boolean AS visivel_cliente,
        $6::integer AS duracao_min,
        $7::numeric AS valor,
        $8::integer AS profissional_id
    )
    INSERT INTO public.servicos_prof 
      (tenant_id, servico_id, servico_nome, ativo, visivel_cliente, duracao_min, valor, profissional_id)
    SELECT tenant_id, servico_id, servico_nome, ativo, visivel_cliente, duracao_min, valor, profissional_id
    FROM dados
    ON CONFLICT (tenant_id, servico_nome_norm)
    DO UPDATE SET 
      servico_id = EXCLUDED.servico_id,
      servico_nome = EXCLUDED.servico_nome,
      ativo = EXCLUDED.ativo,
      visivel_cliente = EXCLUDED.visivel_cliente,
      duracao_min = EXCLUDED.duracao_min,
      valor = EXCLUDED.valor,
      profissional_id = EXCLUDED.profissional_id,
      last_synced_at = now()
    RETURNING *;
  `;

  const values = [
    servico.tenant_id,
    servico.servico_id,
    servico.servico_nome,
    servico.ativo,
    servico.visivel_cliente,
    servico.duracao_min || null,
    servico.valor || null,
    servico.profissional_id || null
  ];

  const result = await pool.query(query, values);
  return result.rows[0];
}

/**
 * Busca serviços por prefixo usando o índice otimizado
 * Implementa a query de performance testada
 */
export async function searchServicesByPrefix(
  pool: Pool,
  tenantId: string,
  prefixo: string,
  limit: number = 20
): Promise<ServicoProf[]> {
  const query = `
    SELECT servico_id, servico_nome, duracao_min, valor
    FROM public.servicos_prof 
    WHERE tenant_id = $1
      AND ativo = true 
      AND visivel_cliente = true 
      AND servico_nome_norm LIKE $2
    ORDER BY servico_nome_norm 
    LIMIT $3;
  `;

  const normalizedPrefix = normalizeServiceName(prefixo);
  const values = [tenantId, `${normalizedPrefix}%`, limit];

  const result = await pool.query(query, values);
  return result.rows;
}

/**
 * Valida se os índices estão sendo usados corretamente
 * Útil para testes de performance
 */
export async function explainServiceSearch(
  pool: Pool,
  tenantId: string,
  prefixo: string
): Promise<any[]> {
  const query = `
    EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
    SELECT servico_id, servico_nome, duracao_min, valor
    FROM public.servicos_prof 
    WHERE tenant_id = $1
      AND ativo = true 
      AND visivel_cliente = true 
      AND servico_nome_norm LIKE $2
    ORDER BY servico_nome_norm 
    LIMIT 20;
  `;

  const normalizedPrefix = normalizeServiceName(prefixo);
  const values = [tenantId, `${normalizedPrefix}%`];

  const result = await pool.query(query, values);
  return result.rows;
}