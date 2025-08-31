import { createClient as createRedisClient, RedisClientType } from 'redis';
import { Client as PgClient } from 'pg';

export type ConversationState = {
  etapaAtual?: string;
  lastText?: string;
  slots?: Record<string, any>;
  updatedAt?: string;
};

let redis: RedisClientType | null = null;
let pg: PgClient | null = null;

export async function initPersistence(opts: { redisUrl?: string | null; databaseUrl?: string | null }) {
  if (opts.redisUrl) {
    redis = createRedisClient({ url: opts.redisUrl });
    redis.on('error', (e: Error) => console.error('Redis error:', e));
    await redis.connect();
  }

  if (opts.databaseUrl) {
    pg = new PgClient({ connectionString: opts.databaseUrl });
    await pg.connect();
    await ensureTables();
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureTables() {
  if (!pg) return;
  await pg.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NULL,
      phone TEXT UNIQUE NOT NULL,
      nome TEXT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS conversation_states (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NULL,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      etapa_atual TEXT NULL,
      state_json JSONB NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NULL
    );

    CREATE TABLE IF NOT EXISTS appointment_requests (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NULL,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      servico_id INTEGER NULL,
      profissional_id INTEGER NULL,
      cliente_id INTEGER NULL,
      datahora_inicio TIMESTAMPTZ NULL,
      duracao_min INTEGER NULL,
      valor NUMERIC NULL,
      confirmado BOOLEAN NULL,
      observacoes TEXT NULL,
      trinks_payload JSONB NULL,
      trinks_response JSONB NULL,
      trinks_agendamento_id BIGINT NULL,
      status TEXT NULL,
      idempotency_key TEXT UNIQUE NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

export async function getOrCreateContactByPhone(phone: string, nome?: string): Promise<{ id: number } | null> {
  if (!pg) return null;
  const existing = await pg.query('SELECT id FROM contacts WHERE phone = $1', [phone]);
  if (existing.rows[0]) return { id: existing.rows[0].id };
  const inserted = await pg.query('INSERT INTO contacts (phone, nome) VALUES ($1, $2) RETURNING id', [phone, nome || null]);
  return { id: inserted.rows[0].id };
}

const REDIS_TTL_SECONDS = 60 * 60 * 48; // 48h

export async function setConversationState(phone: string, state: ConversationState, ttlSeconds = REDIS_TTL_SECONDS, tenantId?: string) {
  const key = `conv:${phone}`;
  const payload = { ...state, updatedAt: nowIso() };
  if (redis) {
    await redis.set(key, JSON.stringify(payload), { EX: ttlSeconds });
  }
  if (pg) {
    const contact = await getOrCreateContactByPhone(phone);
    await pg.query(
      'INSERT INTO conversation_states (tenant_id, contact_id, etapa_atual, state_json, updated_at, expires_at) VALUES ($1,$2,$3,$4,now(),$5)',
      [tenantId || null, contact?.id || null, state.etapaAtual || null, payload, new Date(Date.now() + ttlSeconds * 1000)]
    );
  }
}

export async function getConversationState(phone: string): Promise<ConversationState | null> {
  const key = `conv:${phone}`;
  if (redis) {
    const raw = await redis.get(key);
    if (raw) {
      try { return JSON.parse(raw); } catch { /* ignore */ }
    }
  }
  if (pg) {
    const q = await pg.query('SELECT state_json FROM conversation_states cs JOIN contacts c ON cs.contact_id = c.id WHERE c.phone = $1 ORDER BY cs.updated_at DESC LIMIT 1', [phone]);
    if (q.rows[0]?.state_json) return q.rows[0].state_json as ConversationState;
  }
  return null;
}

export async function recordAppointmentAttempt(params: {
  phone?: string;
  tenantId?: string;
  servicoId?: number;
  profissionalId?: number;
  clienteId?: number;
  dataHoraInicio?: string;
  duracaoEmMinutos?: number;
  valor?: number;
  confirmado?: boolean;
  observacoes?: string;
  idempotencyKey?: string;
  trinksPayload?: any;
  trinksResponse?: any;
  status: 'tentado' | 'sucesso' | 'erro';
  trinksAgendamentoId?: number;
}) {
  if (!pg) return;
  let contactId: number | null = null;
  if (params.phone) {
    const c = await getOrCreateContactByPhone(params.phone);
    contactId = c?.id || null;
  }
  await pg.query(
    `INSERT INTO appointment_requests (
      tenant_id, contact_id, servico_id, profissional_id, cliente_id, datahora_inicio, duracao_min, valor, confirmado, observacoes,
      trinks_payload, trinks_response, trinks_agendamento_id, status, idempotency_key
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      params.tenantId || null,
      contactId,
      params.servicoId || null,
      params.profissionalId || null,
      params.clienteId || null,
      params.dataHoraInicio ? new Date(params.dataHoraInicio) : null,
      params.duracaoEmMinutos || null,
      params.valor || null,
      params.confirmado ?? null,
      params.observacoes || null,
      params.trinksPayload || null,
      params.trinksResponse || null,
      params.trinksAgendamentoId || null,
      params.status,
      params.idempotencyKey || null,
    ]
  );
}

export function getPg() { return pg; }
export function getRedis() { return redis; }