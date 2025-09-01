import { createClient as createRedisClient, RedisClientType } from 'redis';
import { Client as PgClient } from 'pg';

export type ConversationState = {
  etapaAtual?: string;
  lastText?: string;
  slots?: Record<string, any>;
  updatedAt?: string;
  contactInfo?: { pushName?: string; firstName?: string };
  messageHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  }>;
};

let redis: RedisClientType | null = null;
let pg: PgClient | null = null;

export async function initPersistence(opts: { redisUrl?: string | null; databaseUrl?: string | null; databaseSsl?: boolean | 'no-verify' }) {
  console.log('Iniciando persistência...');
  
  // Desabilitar Redis temporariamente
  if (opts.redisUrl) {
    console.log('Redis URL fornecida, mas Redis está desabilitado temporariamente');
    // try {
    //   redis = createRedisClient({ url: opts.redisUrl });
    //   redis.on('error', (e: Error) => console.error('Redis error:', e));
    //   await redis.connect();
    // } catch (err) {
    //   console.error('Falha ao conectar Redis:', err);
    //   redis = null;
    // }
  }

  if (opts.databaseUrl) {
    try {
      console.log('Conectando ao PostgreSQL...');
      const sslConfig = opts.databaseSsl === 'no-verify' ? { rejectUnauthorized: false } : (opts.databaseSsl ? true : undefined);
      pg = new PgClient({ connectionString: opts.databaseUrl, ssl: sslConfig as any });
      await pg.connect();
      console.log('PostgreSQL conectado com sucesso!');
      
      console.log('Criando tabelas...');
      await ensureTables();
      console.log('Tabelas criadas/verificadas com sucesso!');
    } catch (err) {
      console.error('Falha ao conectar PostgreSQL:', err);
      pg = null;
    }
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
      tenant_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      nome TEXT NULL,
      primeiro_nome TEXT NULL,
      push_name TEXT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (tenant_id, phone)
    );

    CREATE TABLE IF NOT EXISTS conversation_states (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      etapa_atual TEXT NULL,
      state_json JSONB NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NULL
    );

    CREATE TABLE IF NOT EXISTS appointment_requests (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
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
  // Adicionar migração para alterar constraints se necessário
  try {
    await pg.query('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_phone_key');
    await pg.query('ALTER TABLE contacts ADD CONSTRAINT contacts_tenant_phone_key UNIQUE (tenant_id, phone)');
    await pg.query('ALTER TABLE contacts ALTER COLUMN tenant_id SET NOT NULL');
  } catch (e) {
    console.error('Migration failed:', e);
  }
  // Adicionar novos campos se não existirem
  try {
    await pg.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS primeiro_nome TEXT NULL');
    await pg.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS push_name TEXT NULL');
  } catch (e) {
    console.error('Migration for new contact fields failed:', e);
  }
  try {
    await pg.query('ALTER TABLE conversation_states ALTER COLUMN tenant_id SET NOT NULL');
  } catch (e) {}
  try {
    await pg.query('ALTER TABLE appointment_requests ALTER COLUMN tenant_id SET NOT NULL');
  } catch (e) {}
}

export async function getOrCreateContactByPhone(
  tenantId: string, 
  phone: string, 
  nome?: string, 
  contactInfo?: { pushName?: string; firstName?: string }
): Promise<{ id: number } | null> {
  if (!pg) return null;
  const existing = await pg.query('SELECT id FROM contacts WHERE tenant_id = $1 AND phone = $2', [tenantId, phone]);
  
  if (existing.rows[0]) {
    // Atualizar informações do contato se fornecidas
    if (contactInfo?.pushName || contactInfo?.firstName) {
      await pg.query(
        'UPDATE contacts SET push_name = COALESCE($3, push_name), primeiro_nome = COALESCE($4, primeiro_nome), updated_at = now() WHERE tenant_id = $1 AND phone = $2',
        [tenantId, phone, contactInfo.pushName, contactInfo.firstName]
      );
    }
    return { id: existing.rows[0].id };
  }
  
  const inserted = await pg.query(
    'INSERT INTO contacts (tenant_id, phone, nome, primeiro_nome, push_name) VALUES ($1, $2, $3, $4, $5) RETURNING id', 
    [tenantId, phone, nome || null, contactInfo?.firstName || null, contactInfo?.pushName || null]
  );
  return { id: inserted.rows[0].id };
}

const REDIS_TTL_SECONDS = 60 * 60 * 48; // 48h

export async function setConversationState(tenantId: string, phone: string, state: ConversationState, ttlSeconds = REDIS_TTL_SECONDS) {
  const key = `conv:${tenantId}:${phone}`;
  const payload = { ...state, updatedAt: nowIso() };
  if (redis) {
    await redis.set(key, JSON.stringify(payload), { EX: ttlSeconds });
  }
  if (pg) {
    const contact = await getOrCreateContactByPhone(tenantId, phone);
    await pg.query(
      'INSERT INTO conversation_states (tenant_id, contact_id, etapa_atual, state_json, updated_at, expires_at) VALUES ($1,$2,$3,$4,now(),$5)',
      [tenantId, contact?.id || null, state.etapaAtual || null, payload, new Date(Date.now() + ttlSeconds * 1000)]
    );
  }
}

export async function getConversationState(tenantId: string, phone: string): Promise<ConversationState | null> {
  const key = `conv:${tenantId}:${phone}`;
  if (redis) {
    const raw = await redis.get(key);
    if (raw) {
      try { return JSON.parse(raw); } catch { /* ignore */ }
    }
  }
  if (pg) {
    const q = await pg.query('SELECT state_json FROM conversation_states cs JOIN contacts c ON cs.contact_id = c.id WHERE cs.tenant_id = $1 AND c.phone = $2 ORDER BY cs.updated_at DESC LIMIT 1', [tenantId, phone]);
    if (q.rows[0]?.state_json) return q.rows[0].state_json as ConversationState;
  }
  return null;
}

export async function recordAppointmentAttempt(params: {
  tenantId: string;
  phone?: string;
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
    const c = await getOrCreateContactByPhone(params.tenantId, params.phone);
    contactId = c?.id || null;
  }
  await pg.query(
    `INSERT INTO appointment_requests (
      tenant_id, contact_id, servico_id, profissional_id, cliente_id, datahora_inicio, duracao_min, valor, confirmado, observacoes,
      trinks_payload, trinks_response, trinks_agendamento_id, status, idempotency_key
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      params.tenantId,
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

// Função para limpar histórico de mensagens antigas (mais de 2 horas)
function cleanOldMessages(messageHistory?: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>): Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> {
  if (!messageHistory) return [];
  
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  return messageHistory.filter(msg => msg.timestamp > twoHoursAgo);
}

// Função para adicionar mensagem ao histórico
export function addMessageToHistory(
  messageHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> = [],
  role: 'user' | 'assistant',
  content: string
): Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> {
  const cleanHistory = cleanOldMessages(messageHistory);
  cleanHistory.push({
    role,
    content,
    timestamp: new Date().toISOString()
  });
  return cleanHistory;
}

// Helpers para testes
export function __setPgForTests(client: any) { pg = client as PgClient; }
export function __resetPgForTests() { pg = null; }

export async function getAllConversationStates(tenantId: string): Promise<any[]> {
  const dbPg = getPg();
  if (!dbPg) {
    throw new Error('Database not initialized');
  }
  const result = await dbPg.query(
    'SELECT phone, state FROM conversation_states WHERE tenant_id = $1',
    [tenantId]
  );
  return result.rows;
}