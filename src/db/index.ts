import { createClient as createRedisClient, RedisClientType } from 'redis';
import { Client as PgClient } from 'pg';
import { pool } from '../infra/db';
import logger from '../utils/logger';

const LEGACY_FALLBACK_ENABLED = process.env.LEGACY_FALLBACK_ENABLED !== 'false';

// Configurações de TTL
const CONV_REDIS_TTL_SECONDS = Number(process.env.CONVERSATION_STATE_REDIS_TTL_SECONDS || 60 * 60 * 2); // 2h no Redis
const CONV_PG_TTL_SECONDS = Number(process.env.CONVERSATION_STATE_PG_TTL_SECONDS || 60 * 60 * 24 * 7); // 7 dias no Postgres
const RL_LIMIT_PER_MIN = Number(process.env.RL_LIMIT_PER_MIN || 30);
const RL_LIMIT_PER_HOUR = Number(process.env.RL_LIMIT_PER_HOUR || 400);

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



function getLegacyPg(): PgClient | null {
  if (!LEGACY_FALLBACK_ENABLED) {
    logger.debug('Fallback do banco de dados legado desabilitado via variável de ambiente.');
    return null;
  }
  const url = process.env.LEGACY_DATABASE_URL;
  if (!url) {
    logger.warn('LEGACY_DATABASE_URL not set. Legacy DB access disabled.');
    return null;
  }
  // Ajuste de SSL: somente ativa SSL quando explicitamente configurado
  const sslMode = String(process.env.LEGACY_DATABASE_SSL || '').trim().toLowerCase();
  const legacySsl = sslMode === 'no-verify' ? { rejectUnauthorized: false } : (sslMode === 'true' || sslMode === '1' ? true : undefined);
  const tempLegacyPg = new PgClient({ connectionString: url, ssl: legacySsl as any });
  tempLegacyPg.connect().catch((err) => {
    logger.error('Failed to connect to legacy database:', err);
  });
  return tempLegacyPg;
}

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
      // Usar o pool centralizado em vez de criar novo cliente
      await pool.query('SELECT 1');
      console.log('PostgreSQL conectado com sucesso!');
      
      console.log('Criando tabelas...');
      await ensureTables();
      console.log('Tabelas criadas/verificadas com sucesso!');
    } catch (err) {
      console.error('Falha ao conectar PostgreSQL:', err);

    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureTables() {
  await pool.query(`
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

    CREATE TABLE IF NOT EXISTS client_sessions (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      trinks_client_id INTEGER NULL,
      client_name TEXT NULL,
      client_email TEXT NULL,
      push_name TEXT NULL,
      first_name TEXT NULL,
      session_data JSONB DEFAULT '{}',
      last_activity TIMESTAMPTZ DEFAULT now(),
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (tenant_id, phone)
    );

    -- Catálogo local de serviços por profissional (0 = genérico/qualquer)
    CREATE TABLE IF NOT EXISTS servicos_prof (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      servico_id INTEGER NOT NULL,
      servico_nome TEXT NOT NULL,
      duracao_min INTEGER NOT NULL,
      valor NUMERIC NULL,
      profissional_id INTEGER NOT NULL DEFAULT 0,
      visivel_cliente BOOLEAN DEFAULT TRUE,
      ativo BOOLEAN DEFAULT TRUE,
      last_synced_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (tenant_id, servico_id, profissional_id)
    );
  `);
  // Adicionar migração para alterar constraints se necessário
  try {
    await pool.query('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_phone_key');
  await pool.query('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_tenant_phone_key');
  await pool.query('ALTER TABLE contacts ADD CONSTRAINT contacts_tenant_phone_key UNIQUE (tenant_id, phone)');
  await pool.query('ALTER TABLE contacts ALTER COLUMN tenant_id SET NOT NULL');
  } catch (e: any) {
    console.error('Migration failed:', e);
  }
  // Adicionar novos campos se não existirem
  try {
    await pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS primeiro_nome TEXT NULL');
  await pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS push_name TEXT NULL');
  } catch (e: any) {
    console.error('Migration for new contact fields failed:', e);
  }
  try {
    await pool.query('ALTER TABLE conversation_states ALTER COLUMN tenant_id SET NOT NULL');
  } catch (e: any) {}
  try {
    await pool.query('ALTER TABLE appointment_requests ALTER COLUMN tenant_id SET NOT NULL');
  } catch (e: any) {}
  // Adicionar constraint UNIQUE para conversation_states para permitir UPSERT
  try {
    await pool.query('ALTER TABLE conversation_states ADD CONSTRAINT conversation_states_tenant_contact_key UNIQUE (tenant_id, contact_id)');
  } catch (e: any) {
    // Constraint já existe ou erro na criação
  }
}

export async function getOrCreateContactByPhone(
  tenantId: string, 
  phone: string, 
  nome?: string, 
  contactInfo?: { pushName?: string; firstName?: string }
): Promise<{ id: number } | null> {
  const existing = await pool.query('SELECT id FROM contacts WHERE tenant_id = $1 AND phone = $2', [tenantId, phone]);
  
  if (existing.rows[0]) {
    // Atualizar informações do contato se fornecidas
    if (contactInfo?.pushName || contactInfo?.firstName) {
      await pool.query(
        'UPDATE contacts SET push_name = COALESCE($3, push_name), primeiro_nome = COALESCE($4, primeiro_nome), updated_at = now() WHERE tenant_id = $1 AND phone = $2',
        [tenantId, phone, contactInfo.pushName, contactInfo.firstName]
      );
    }
    return { id: existing.rows[0].id };
  }
  
  const inserted = await pool.query(
    'INSERT INTO contacts (tenant_id, phone, nome, primeiro_nome, push_name) VALUES ($1, $2, $3, $4, $5) RETURNING id', 
    [tenantId, phone, nome || null, contactInfo?.firstName || null, contactInfo?.pushName || null]
  );
  return { id: inserted.rows[0].id };
}

// TTL padrão do Redis para estado de conversa (ajustado para 2h)
const REDIS_TTL_SECONDS = CONV_REDIS_TTL_SECONDS;

export async function setConversationState(tenantId: string, phone: string, state: ConversationState, ttlSeconds = REDIS_TTL_SECONDS) {
  const key = `conv:${tenantId}:${phone}`;
  const payload = { ...state, updatedAt: nowIso() };
  if (redis) {
    await redis.set(key, JSON.stringify(payload), { EX: ttlSeconds });
  }
  {
    const contact = await getOrCreateContactByPhone(tenantId, phone);
    // Usar UPSERT para manter apenas o estado mais recente por contato
    await pool.query(
      `INSERT INTO conversation_states (tenant_id, contact_id, etapa_atual, state_json, updated_at, expires_at) 
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (tenant_id, contact_id) 
       DO UPDATE SET 
         etapa_atual = EXCLUDED.etapa_atual,
         state_json = EXCLUDED.state_json,
         updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at`,
      [tenantId, contact?.id || null, state.etapaAtual || null, payload, new Date(Date.now() + CONV_PG_TTL_SECONDS * 1000)]
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
  {
    const q = await pool.query('SELECT state_json FROM conversation_states cs JOIN contacts c ON cs.contact_id = c.id WHERE cs.tenant_id = $1 AND c.phone = $2 ORDER BY cs.updated_at DESC LIMIT 1', [tenantId, phone]);
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
  let contactId: number | null = null;
  if (params.phone) {
    const c = await getOrCreateContactByPhone(params.tenantId, params.phone);
    contactId = c?.id || null;
  }
  await pool.query(
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

// Função para registrar interações pós-agendamento
export async function recordPostBookingInteraction(params: {
  tenantId: string;
  phone: string;
  bookingId: string | number;
  interactionType: string;
  timestamp: Date;
  metadata?: any;
}) {
  
  try {
    await pool.query(
      `INSERT INTO post_booking_interactions (
        phone_number, booking_id, interaction_type, interaction_data, created_at
      ) VALUES ($1, $2, $3, $4, $5)`,
      [
        params.phone,
        params.bookingId.toString(),
        params.interactionType,
        JSON.stringify(params.metadata || {}),
        params.timestamp
      ]
    );
    
    logger.info('Post-booking interaction recorded', {
      phone: params.phone,
      bookingId: params.bookingId,
      interactionType: params.interactionType
    });
  } catch (error) {
    logger.error('Error recording post-booking interaction:', error);
  }
}

export function getPg() { return pool; }
export function getRedis() { return redis; }

// Função para limpar histórico de mensagens antigas (mais de 2 horas)
function cleanOldMessages(messageHistory?: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>): Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> {
  if (!messageHistory || messageHistory.length <= 30) return messageHistory || [];
  
  // Estratégia inteligente: manter as primeiras 5 mensagens (contexto inicial) 
  // e as últimas 25 mensagens (contexto recente)
  const firstMessages = messageHistory.slice(0, 5);
  const recentMessages = messageHistory.slice(-25);
  
  // Evitar duplicatas se houver sobreposição
  if (messageHistory.length <= 30) {
    return messageHistory;
  }
  
  return [...firstMessages, ...recentMessages.slice(5)];
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

// Função para buscar ou criar sessão do cliente
export async function getOrCreateClientSession(
  tenantId: string,
  phone: string,
  contactInfo?: { pushName?: string; firstName?: string }
): Promise<{
  id: number;
  trinksClientId?: number;
  clientName?: string;
  clientEmail?: string;
  pushName?: string;
  firstName?: string;
  sessionData: any;
}> {
  try {

    // Buscar sessão existente
    const existingSession = await pool.query(
      'SELECT * FROM client_sessions WHERE tenant_id = $1 AND phone = $2',
      [tenantId, phone]
    );

    if (existingSession.rows.length > 0) {
      const session = existingSession.rows[0];
      
      // Atualizar informações de contato se fornecidas
      if (contactInfo?.pushName || contactInfo?.firstName) {
        await pool.query(
          'UPDATE client_sessions SET push_name = COALESCE($3, push_name), first_name = COALESCE($4, first_name), last_activity = now() WHERE tenant_id = $1 AND phone = $2',
          [tenantId, phone, contactInfo?.pushName, contactInfo?.firstName]
        );
      }
      
      return {
        id: session.id,
        trinksClientId: session.trinks_client_id,
        clientName: session.client_name,
        clientEmail: session.client_email,
        pushName: contactInfo?.pushName || session.push_name,
        firstName: contactInfo?.firstName || session.first_name,
        sessionData: session.session_data || {}
      };
    }

    // Criar nova sessão
    const newSession = await pool.query(
      `INSERT INTO client_sessions (tenant_id, phone, push_name, first_name, session_data, last_activity)
       VALUES ($1, $2, $3, $4, $5, now())
       RETURNING *`,
      [tenantId, phone, contactInfo?.pushName, contactInfo?.firstName, '{}']
    );

    return {
      id: newSession.rows[0].id,
      pushName: contactInfo?.pushName,
      firstName: contactInfo?.firstName,
      sessionData: {}
    };
  } catch (error) {
    console.error('Erro ao buscar/criar sessão do cliente:', error);
    return {
      id: 0,
      pushName: contactInfo?.pushName,
      firstName: contactInfo?.firstName,
      sessionData: {}
    };
  }
}

// Função para atualizar dados da sessão do cliente
export async function updateClientSession(
  tenantId: string,
  phone: string,
  updates: {
    trinksClientId?: number;
    clientName?: string;
    clientEmail?: string;
    sessionData?: any;
  }
): Promise<void> {
  try {
    const setClause = [];
    const values = [tenantId, phone];
    let paramIndex = 3;

    if (updates.trinksClientId !== undefined) {
      setClause.push(`trinks_client_id = $${paramIndex++}`);
      values.push(updates.trinksClientId.toString());
    }
    if (updates.clientName !== undefined) {
      setClause.push(`client_name = $${paramIndex++}`);
      values.push(updates.clientName);
    }
    if (updates.clientEmail !== undefined) {
      setClause.push(`client_email = $${paramIndex++}`);
      values.push(updates.clientEmail);
    }
    if (updates.sessionData !== undefined) {
      setClause.push(`session_data = $${paramIndex++}`);
      values.push(JSON.stringify(updates.sessionData));
    }

    if (setClause.length > 0) {
      setClause.push('last_activity = now()');
      await pool.query(
        `UPDATE client_sessions SET ${setClause.join(', ')} WHERE tenant_id = $1 AND phone = $2`,
        values
      );
    }
  } catch (error) {
    console.error('Erro ao atualizar sessão do cliente:', error);
  }
}

// Função para buscar cliente no Trinks e atualizar sessão
export async function searchAndUpdateTrinksClient(
  tenantId: string,
  phone: string
): Promise<{ found: boolean; clientData?: any }> {
  try {
    const { Trinks } = await import('../integrations/trinks');
    
    // Buscar cliente no Trinks pelo telefone
    const normalizedPhone = phone.replace(/\D/g, '');
    const clients = await Trinks.buscarClientes({ telefone: normalizedPhone });
    
    const foundClient = clients && clients.length > 0 ? clients[0] : null;

    if (foundClient) {
      // Atualizar sessão com dados do cliente encontrado
      await updateClientSession(tenantId, phone, {
        trinksClientId: foundClient.id || foundClient.clienteId || foundClient.codigo,
        clientName: foundClient.nome,
        clientEmail: foundClient.email
      });

      return {
        found: true,
        clientData: {
          id: foundClient.id || foundClient.clienteId || foundClient.codigo,
          name: foundClient.nome,
          email: foundClient.email,
          phone: foundClient.telefone || foundClient.celular
        }
      };
    }

    return { found: false };
  } catch (error) {
    console.error('Erro ao buscar cliente no Trinks:', error);
    return { found: false };
  }
}

// Helpers para testes
export function __setPgForTests(client: any) { /* No longer needed */ }
export function __resetPgForTests() { /* No longer needed */ }

export async function getAllConversationStates(tenantId: string): Promise<any[]> {
  const result = await pool.query(
    'SELECT phone, state FROM conversation_states WHERE tenant_id = $1',
    [tenantId]
  );
  return result.rows;
}

// Função para limpar estados de conversa expirados
export async function cleanExpiredConversationStates(): Promise<void> {
  try {
    const result = await pool.query(
      'DELETE FROM conversation_states WHERE expires_at < now()'
    );
    if (result.rowCount && result.rowCount > 0) {
      logger.info(`Cleaned ${result.rowCount} expired conversation states`);
    }
  } catch (error) {
    logger.error('Error cleaning expired conversation states:', error);
  }
}

export async function upsertServicosProf(
  tenantId: string,
  items: Array<{ servicoId: number; servicoNome: string; duracaoMin: number; valor?: number | null; profissionalId?: number | null; visivelCliente?: boolean | null; ativo?: boolean | null }>
): Promise<void> {
  if (!items || items.length === 0) return;
  
  // Normalizar e deduplicar itens antes da inserção
  const normalizedItems = new Map<string, typeof items[0]>();
  
  for (const it of items) {
    const profissionalId = it.profissionalId ?? 0;
    const normalizedNome = it.servicoNome.trim().toLowerCase();
    const dedupeKey = `${tenantId}:${normalizedNome}:${profissionalId}`;
    
    // Manter apenas o último item para cada chave de dedupe
    normalizedItems.set(dedupeKey, {
      ...it,
      servicoNome: it.servicoNome.trim(), // Manter original para inserção
      profissionalId
    });
  }
  
  // Inserir itens normalizados com tratamento de conflitos
  for (const it of normalizedItems.values()) {
    try {
      // Tentar inserir primeiro
      await pool.query(
        `INSERT INTO servicos_prof (tenant_id, servico_id, servico_nome, duracao_min, valor, profissional_id, visivel_cliente, ativo, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, TRUE), COALESCE($8, TRUE), now())
         ON CONFLICT (tenant_id, servico_id, profissional_id)
         DO UPDATE SET servico_nome = EXCLUDED.servico_nome,
                       duracao_min = EXCLUDED.duracao_min,
                       valor = EXCLUDED.valor,
                       visivel_cliente = EXCLUDED.visivel_cliente,
                       ativo = EXCLUDED.ativo,
                       last_synced_at = now()`,
        [tenantId, it.servicoId, it.servicoNome, it.duracaoMin, it.valor ?? null, it.profissionalId, it.visivelCliente ?? true, it.ativo ?? true]
      );
    } catch (error: any) {
      // Se houver conflito na constraint única de servico_nome_norm, fazer merge
      if (error.code === '23505' && error.constraint === 'uniq_servico_nome_norm') {
        logger.warn(`Conflito de nome normalizado detectado para tenant ${tenantId}`, {
          servicoNome: it.servicoNome,
          servicoId: it.servicoId,
          profissionalId: it.profissionalId
        });
        
        // Buscar registro existente para merge
        const existingResult = await pool.query(
          `SELECT * FROM servicos_prof 
           WHERE tenant_id = $1 AND servico_nome_norm = lower(btrim($2)) 
           LIMIT 1`,
          [tenantId, it.servicoNome]
        );
        
        if (existingResult.rows.length > 0) {
          const existing = existingResult.rows[0];
          
          // Fazer merge dos dados (priorizar dados mais recentes)
          const mergedData = {
            servicoId: it.servicoId, // Manter o novo ID
            servicoNome: it.servicoNome, // Manter o novo nome
            duracaoMin: it.duracaoMin,
            valor: it.valor ?? existing.valor, // Usar novo valor ou manter existente
            profissionalId: it.profissionalId,
            visivelCliente: it.visivelCliente ?? existing.visivel_cliente,
            ativo: it.ativo ?? existing.ativo
          };
          
          // Atualizar registro existente
          await pool.query(
            `UPDATE servicos_prof 
             SET servico_id = $2, servico_nome = $3, duracao_min = $4, valor = $5, 
                 profissional_id = $6, visivel_cliente = $7, ativo = $8, last_synced_at = now()
             WHERE id = $1`,
            [existing.id, mergedData.servicoId, mergedData.servicoNome, mergedData.duracaoMin, 
             mergedData.valor, mergedData.profissionalId, mergedData.visivelCliente, mergedData.ativo]
          );
          
          logger.info(`Merge realizado com sucesso para serviço duplicado`, {
            tenantId,
            existingId: existing.id,
            mergedData
          });
        }
      } else {
        // Re-throw outros erros
        throw error;
      }
    }
  }
}

export async function getServicosSuggestions(
  tenantId: string,
  term: string,
  limit = 5
): Promise<Array<{ servicoId: number; servicoNome: string; duracaoMin: number; valor: number | null }>> {
  // Cache em Redis por termo para acelerar sugestões
  const cacheKey = `cache:servicos:${tenantId}:${(term || '').toLowerCase()}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
  }


  const normalizedTerm = term.toLowerCase().trim();
  const like = `${normalizedTerm}%`;
  const max = Math.max(1, Math.min(10, limit));
  const q = await pool.query(
    `SELECT servico_id as "servicoId",
            MIN(servico_nome) as "servicoNome",
            MIN(duracao_min) as "duracaoMin",
            MIN(valor) as valor
       FROM servicos_prof
      WHERE tenant_id = $1
        AND ativo IS TRUE
        AND visivel_cliente IS TRUE
        AND servico_nome_norm LIKE $2
      GROUP BY servico_id
      ORDER BY MIN(valor) NULLS LAST, MIN(servico_nome_norm)
      LIMIT $3`,
    [tenantId, like, max]
  );
  if (q.rows.length > 0) {
    if (redis) {
      try { await redis.set(cacheKey, JSON.stringify(q.rows), { EX: 60 * 60 * 24 }); } catch {}
    }
    return q.rows;
  }

  // Fallback: consultar tabela legada servicos_profissionais_marcleiaabade quando não houver sugestões
  if (!LEGACY_FALLBACK_ENABLED) {
    logger.debug('Fallback do banco de dados legado desabilitado via variável de ambiente.');
    return [];
  }
  const legacyClient = getLegacyPg();
  if (!legacyClient) return [];
  try {
    const q2 = await legacyClient.query(
      `SELECT servicoid  as "servicoId",
              nomeservico as "servicoNome",
              duracaoemminutos as "duracaoMin",
              preco        as valor
         FROM servicos_profissionais_marcleiaabade
        WHERE visivelparacliente IS TRUE
          AND lower(nomeservico) LIKE $1
        ORDER BY valor NULLS LAST, nomeservico
        LIMIT $2`,
      [like, max]
    );
    if (redis) {
      try { await redis.set(cacheKey, JSON.stringify(q2.rows), { EX: 60 * 60 * 24 }); } catch {}
    }
    return q2.rows;
  } catch (err) {
    logger.warn('Legacy fallback disabled due to error:', (err as any)?.message || err);
    return [];
  }
}

export async function existsServicoInCatalog(
  tenantId: string,
  servicoId: number,
  profissionalId?: number | null
): Promise<boolean> {
  if (profissionalId == null) {
    const r = await pool.query(
      'SELECT 1 FROM servicos_prof WHERE tenant_id = $1 AND servico_id = $2 AND ativo IS TRUE AND visivel_cliente IS TRUE LIMIT 1',
      [tenantId, servicoId]
    );
    return r.rows.length > 0;
  }
  const r = await pool.query(
    'SELECT 1 FROM servicos_prof WHERE tenant_id = $1 AND servico_id = $2 AND profissional_id = $3 AND ativo IS TRUE AND visivel_cliente IS TRUE LIMIT 1',
    [tenantId, servicoId, profissionalId]
  );
  return r.rows.length > 0;
}

// ===== Redis Helpers: Deduplicação, Rate Limit e Idempotência ===== //

/** Marca uma mensagem como processada usando SET NX. Retorna true se foi a primeira vez. */
export async function markMessageProcessed(messageId: string, ttlSeconds = 60 * 15): Promise<boolean> {
  if (!redis || !messageId) return true; // se não há redis, não bloqueia processamento
  try {
    const ok = await redis.set(`msg:${messageId}`, '1', { NX: true, EX: ttlSeconds });
    return ok === 'OK';
  } catch {
    return true;
  }
}

/** Aplica rate limit por janela. Retorna true se permitido. */
export async function rateLimitAllow(tenantId: string, phone: string, windowSeconds: number, maxCount: number): Promise<boolean> {
  if (!redis) return true;
  const key = `rl:${tenantId}:${phone}:${windowSeconds}`;
  try {
    const val = await redis.incr(key);
    if (val === 1) {
      await redis.expire(key, windowSeconds);
    }
    return val <= maxCount;
  } catch {
    return true;
  }
}

/** Atalho: aplica limites padrão de 1m e 1h. */
export async function isRateLimited(tenantId: string, phone: string): Promise<boolean> {
  const ok1 = await rateLimitAllow(tenantId, phone, 60, RL_LIMIT_PER_MIN);
  const ok2 = await rateLimitAllow(tenantId, phone, 60 * 60, RL_LIMIT_PER_HOUR);
  return !(ok1 && ok2);
}

/** Tenta adquirir chave de idempotência (NX). */
export async function acquireIdempotencyKey(key: string, ttlSeconds = 60 * 30): Promise<boolean> {
  if (!redis || !key) return true;
  try {
    const ok = await redis.set(`idemp:booking:${key}`, 'inflight', { NX: true, EX: ttlSeconds });
    return ok === 'OK';
  } catch {
    return true;
  }
}

/** Define resultado associado à idempotência (por exemplo, ID criado). */
export async function setIdempotencyResult(key: string, value: any, ttlSeconds = 60 * 30): Promise<void> {
  if (!redis || !key) return;
  try {
    await redis.set(`idemp:booking:${key}:result`, JSON.stringify(value), { EX: ttlSeconds });
  } catch {}
}

/** Obtém resultado previamente salvo para idempotência. */
export async function getIdempotencyResult<T = any>(key: string): Promise<T | null> {
  if (!redis || !key) return null;
  try {
    const raw = await redis.get(`idemp:booking:${key}:result`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Libera a chave de idempotência (permite nova tentativa). */
export async function releaseIdempotencyKey(key: string): Promise<void> {
  if (!redis || !key) return;
  try {
    await redis.del(`idemp:booking:${key}`);
  } catch {}
}

// Export pg client for direct database access
export { pool as pg, redis };
export const db = pool;